// Git primitives, written from the format: SHA-1 object ids over loose-object framing, tree and
// commit parse/build, smart-HTTP pkt-lines, pack read/write with offset and reference deltas,
// base64, and GitHub's opaque node ids.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitType;
  data: Buffer;
}

const TYPE_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id git gives an object: SHA-1 over `<type> <size>\0` plus the body. */
export function objectId(type: GitType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

export function looseObject(type: GitType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
}

export function encodeBase64(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64');
}

export function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function treeKey(entry: TreeEntry): Buffer {
  const name = entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
  return Buffer.from(name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => Buffer.compare(treeKey(a), treeKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits and tags

export interface Signature {
  name: string;
  email: string;
  date: number;
  tz: string;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
}

export function formatSignature(sig: Signature): string {
  return `${sig.name} <${sig.email}> ${sig.date} ${sig.tz}`;
}

export function buildCommit(data: CommitData): Buffer {
  const lines: string[] = [`tree ${data.tree}`];
  for (const parent of data.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatSignature(data.author)}`);
  lines.push(`committer ${formatSignature(data.committer)}`);
  const message = data.message.endsWith('\n') ? data.message : `${data.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: Signature = { name: '', email: '', date: 0, tz: '+0000' };
  let committer: Signature = author;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseSignature(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseSignature(line.slice(10));
  }
  return { tree, parents, author, committer, message: message.replace(/\n$/, '') };
}

function parseSignature(text: string): Signature {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text.trim(), email: '', date: 0, tz: '+0000' };
  return { name: match[1] ?? '', email: match[2] ?? '', date: Number(match[3] ?? 0), tz: match[4] ?? '+0000' };
}

export interface TagData {
  object: string;
  type: GitType;
  tag: string;
  tagger: Signature;
  message: string;
}

export function buildTag(data: TagData): Buffer {
  const text = `object ${data.object}\ntype ${data.type}\ntag ${data.tag}\ntagger ${formatSignature(data.tagger)}\n\n${data.message.endsWith('\n') ? data.message : `${data.message}\n`}`;
  return Buffer.from(text, 'utf8');
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function parsePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** The text of the data packets up to the first flush, joined (capability and command parsing). */
export function pktDataText(packets: readonly Pkt[]): string {
  let out = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') out += packet.data.toString('utf8');
  }
  return out;
}

// ---------------------------------------------------------------- deltas and packs

function readVarint(data: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = data[offset] ?? 0;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: offset };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const baseSize = readVarint(delta, offset);
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  offset = baseSize.next;
  const outSize = readVarint(delta, offset);
  offset = outSize.next;
  const out = Buffer.alloc(outSize.value);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) { copyOffset += delta[offset] ?? 0; offset += 1; }
      if ((op & 0x02) !== 0) { copyOffset += (delta[offset] ?? 0) << 8; offset += 1; }
      if ((op & 0x04) !== 0) { copyOffset += (delta[offset] ?? 0) << 16; offset += 1; }
      if ((op & 0x08) !== 0) { copyOffset += (delta[offset] ?? 0) * 0x1000000; offset += 1; }
      if ((op & 0x10) !== 0) { copySize += delta[offset] ?? 0; offset += 1; }
      if ((op & 0x20) !== 0) { copySize += (delta[offset] ?? 0) << 8; offset += 1; }
      if ((op & 0x40) !== 0) { copySize += (delta[offset] ?? 0) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      written += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  return out.subarray(0, written);
}

export interface PackedObject {
  type: GitType;
  data: Buffer;
  sha: string;
}

/** The smallest prefix of `data` that forms one complete zlib stream, and the inflated bytes. */
function inflatePrefix(data: Buffer): { inflated: Buffer; consumed: number } {
  let low = 1;
  let high = data.length;
  let best: Buffer | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const inflated = inflateSync(data.subarray(0, mid));
      best = inflated;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (best === null) {
    const inflated = inflateSync(data);
    return { inflated, consumed: data.length };
  }
  return { inflated: best, consumed: low };
}

/**
 * Read a pack: header, object entries (full objects, offset deltas and reference deltas), then the
 * trailing checksum. `lookup` resolves a reference delta's base which the pack does not carry.
 */
export function readPack(buffer: Buffer, lookup: (sha: string) => GitObject | undefined = () => undefined): PackedObject[] {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') return [];
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) return [];
  const count = buffer.readUInt32BE(8);
  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseSha?: string;
  }
  const raws: RawEntry[] = [];
  const byOffset = new Map<number, PackedObject>();
  const bySha = new Map<string, GitObject>();
  const resolved: PackedObject[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = buffer[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buffer[offset] ?? 0;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode === 6) {
      let byte2 = buffer[offset] ?? 0;
      offset += 1;
      let distance = byte2 & 0x7f;
      while ((byte2 & 0x80) !== 0) {
        byte2 = buffer[offset] ?? 0;
        offset += 1;
        distance = ((distance + 1) * 128) + (byte2 & 0x7f);
      }
      const { inflated, consumed } = inflatePrefix(buffer.subarray(offset));
      offset += consumed;
      raws.push({ offset: start, typeCode, data: inflated, baseOffset: start - distance });
      continue;
    }
    if (typeCode === 7) {
      const baseSha = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { inflated, consumed } = inflatePrefix(buffer.subarray(offset));
      offset += consumed;
      raws.push({ offset: start, typeCode, data: inflated, baseSha });
      continue;
    }
    if (!(typeCode in CODE_TYPE)) {
      const { inflated, consumed } = inflatePrefix(buffer.subarray(offset));
      offset += consumed;
      raws.push({ offset: start, typeCode, data: inflated });
      continue;
    }
    const { inflated, consumed } = inflatePrefix(buffer.subarray(offset));
    offset += consumed;
    raws.push({ offset: start, typeCode, data: inflated });
    void size;
  }

  const remember = (entry: RawEntry, type: GitType, data: Buffer): PackedObject => {
    const sha = objectId(type, data);
    const object: PackedObject = { type, data, sha };
    byOffset.set(entry.offset, object);
    bySha.set(sha, object);
    resolved.push(object);
    return object;
  };

  let pending = raws.slice();
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    const next: RawEntry[] = [];
    for (const entry of pending) {
      if (entry.typeCode !== 6 && entry.typeCode !== 7) {
        const type = CODE_TYPE[entry.typeCode] as GitType | undefined;
        if (type !== undefined) {
          remember(entry, type, entry.data);
          progress = true;
        }
        continue;
      }
      let base: GitObject | undefined;
      if (entry.typeCode === 6 && entry.baseOffset !== undefined) {
        const found = byOffset.get(entry.baseOffset);
        if (found !== undefined) base = found;
      } else if (entry.baseSha !== undefined) {
        base = bySha.get(entry.baseSha) ?? lookup(entry.baseSha);
      }
      if (base === undefined) {
        next.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.data);
      remember(entry, base.type, data);
      progress = true;
    }
    pending = next;
  }
  return resolved;
}

function encodePackHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A pack holding every object whole (no deltas), version 2, with its trailing SHA-1. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

// ---------------------------------------------------------------- node ids

const NODE_KINDS: Record<string, string> = {
  Repository: 'Repository',
  User: 'User',
  Organization: 'Organization',
  Issue: 'Issue',
  PullRequest: 'PullRequest',
  Label: 'Label',
  Commit: 'Commit',
  Ref: 'Ref',
  Branch: 'Ref',
};

/** An opaque GitHub-style node id: base64 of `<binary-prefix>:<Kind><id>`. */
export function encodeNodeId(kind: string, id: number | string): string {
  const name = NODE_KINDS[kind] ?? kind;
  const prefix = name.length.toString().padStart(3, '0');
  return Buffer.from(`${prefix}:${name}${id}`, 'utf8').toString('base64');
}

export interface DecodedNode {
  kind: string;
  id: string;
}

export function decodeNodeId(node: string): DecodedNode | null {
  try {
    const text = Buffer.from(node, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const rest = text.slice(colon + 1);
    const kinds = ['PullRequest', 'Repository', 'Organization', 'Commit', 'Issue', 'Label', 'User', 'Ref', 'Branch'];
    for (const kind of kinds) {
      if (rest.startsWith(kind)) return { kind, id: rest.slice(kind.length) };
    }
    return null;
  } catch {
    return null;
  }
}
