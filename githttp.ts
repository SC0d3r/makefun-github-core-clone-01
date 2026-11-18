// Git smart HTTP: protocol v0/v2 ref advertisements, v2 ls-refs and fetch (shallow and deep,
// incremental negotiation, side-band-64k packfile framing), and receive-pack push with a
// report-status (or report-status-v2) demuxed through side-band-64k. Objects are real git
// objects; a push stores what its pack carries and a fetch walks the reachable graph.
import {
  DELIM_PKT,
  FLUSH_PKT,
  parseCommit,
  parsePktLines,
  parseTree,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './lib.ts';
import { Forge, type Repo } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'git/2.43.0';
const SIDEBAND_CHUNK = 60_000;

export interface GitAnswer {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
}

function result(contentType: string, body: Buffer): GitAnswer {
  return { status: 200, contentType, headers: {}, body };
}

function notFound(): GitAnswer {
  return {
    status: 404,
    contentType: 'application/json; charset=utf-8',
    headers: {},
    body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
  };
}

interface GitTarget {
  owner: string;
  repo: string;
  action: 'info' | 'upload' | 'receive';
  service: 'git-upload-pack' | 'git-receive-pack';
}

function parseTarget(pathname: string, query: URLSearchParams): GitTarget | null {
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return null;
  const action = match[3];
  const service = action === 'info/refs'
    ? (query.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack')
    : action === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
  return {
    owner: decodeURIComponent(match[1] as string),
    repo: decodeURIComponent(match[2] as string),
    action: action === 'info/refs' ? 'info' : service === 'git-receive-pack' ? 'receive' : 'upload',
    service,
  };
}

// ---------------------------------------------------------------- object graph walking

function addTree(repo: Repo, sha: string, out: Set<string>): void {
  if (out.has(sha)) return;
  const object = repo.object(sha);
  if (object === undefined || object.type !== 'tree') return;
  out.add(sha);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000' || entry.mode === '040000') addTree(repo, entry.sha, out);
    else out.add(entry.sha);
  }
}

function tagTarget(data: Buffer): string | undefined {
  const text = data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? undefined : (match[1] as string);
}

/** Every object reachable from `roots`: commits and their history, trees, blobs and tags. */
function reachable(repo: Repo, roots: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = roots.slice();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const object = repo.object(sha);
    if (object === undefined) continue;
    out.add(sha);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addTree(repo, commit.tree, out);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      const target = tagTarget(object.data);
      if (target !== undefined) stack.push(target);
    } else if (object.type === 'tree') {
      addTree(repo, sha, out);
    }
  }
  return out;
}

interface DepthWalk {
  out: Set<string>;
  boundary: string[];
}

/** Objects for a depth-limited clone: commits at distance < depth, their full trees, no parents beyond. */
function reachableDepth(repo: Repo, wants: readonly string[], depth: number): DepthWalk {
  const out = new Set<string>();
  const boundary: string[] = [];
  const best = new Map<string, number>();
  const queue: Array<{ sha: string; distance: number }> = [];
  for (const want of wants) {
    const object = repo.object(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      out.add(want);
      const target = tagTarget(object.data);
      if (target !== undefined) queue.push({ sha: target, distance: 0 });
      continue;
    }
    queue.push({ sha: want, distance: 0 });
  }
  while (queue.length > 0) {
    const { sha, distance } = queue.shift() as { sha: string; distance: number };
    const prior = best.get(sha);
    if (prior !== undefined && prior <= distance) continue;
    best.set(sha, distance);
    const object = repo.object(sha);
    if (object === undefined || object.type !== 'commit') continue;
    out.add(sha);
    const commit = parseCommit(object.data);
    addTree(repo, commit.tree, out);
    if (distance + 1 < depth) {
      for (const parent of commit.parents) queue.push({ sha: parent, distance: distance + 1 });
    } else if (commit.parents.length > 0) {
      boundary.push(sha);
    }
  }
  return { out, boundary };
}

/** Objects a shallow client holds from its haves: stop at the shallow boundary, do not walk parents past it. */
function reachableStopping(repo: Repo, roots: readonly string[], boundaries: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = roots.slice();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const object = repo.object(sha);
    if (object === undefined) continue;
    out.add(sha);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addTree(repo, commit.tree, out);
      if (!boundaries.has(sha)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      const target = tagTarget(object.data);
      if (target !== undefined) stack.push(target);
    } else if (object.type === 'tree') {
      addTree(repo, sha, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function peelRef(repo: Repo, sha: string): string | undefined {
  const object = repo.object(sha);
  if (object === undefined || object.type !== 'tag') return undefined;
  let target = tagTarget(object.data);
  for (let guard = 0; target !== undefined && guard < 16; guard += 1) {
    const next = repo.object(target);
    if (next === undefined) return target;
    if (next.type !== 'tag') return target;
    target = tagTarget(next.data);
  }
  return target;
}

function uploadPackV2(repo: Repo): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine('server-option\n'),
    FLUSH_PKT,
  ]);
}

function refLinesV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress agent=${AGENT} symref=HEAD:refs/heads/main`
    : `report-status side-band-64k delete-refs ofs-delta quiet agent=${AGENT}`;
  const entries = sortedRefs(repo);
  const head = repo.tip();
  const lines: Array<[string, string]> = [];
  if (head !== undefined) lines.push([head, 'HEAD']);
  for (const [name, sha] of entries) lines.push([sha, name]);
  if (lines.length === 0) {
    return Buffer.concat([
      pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`),
      FLUSH_PKT,
    ]);
  }
  const parts: Buffer[] = [];
  lines.forEach(([sha, name], index) => {
    parts.push(pktLine(`${sha} ${name}${index === 0 ? `\u0000${capabilities}` : ''}\n`));
    if (name.startsWith('refs/tags/')) {
      const peeled = peelRef(repo, sha);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  });
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): Buffer {
  if (service === 'git-upload-pack' && protocolV2) return uploadPackV2(repo);
  return Buffer.concat([
    pktLine(`# service=${service}\n`),
    FLUSH_PKT,
    refLinesV0(repo, service),
  ]);
}

// ---------------------------------------------------------------- v2 request parsing

interface V2Request {
  command: string;
  sections: string[][];
  keys: Map<string, string>;
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  done: boolean;
}

function parseV2(body: Buffer): V2Request | null {
  const packets = parsePktLines(body);
  const sections: string[][] = [[]];
  const request: V2Request = {
    command: '',
    sections,
    keys: new Map(),
    wants: [],
    haves: [],
    shallow: [],
    deepen: undefined,
    peel: false,
    symrefs: false,
    unborn: false,
    prefixes: [],
    done: false,
  };
  for (const packet of packets) {
    if (packet.kind === 'flush' || packet.kind === 'response-end') break;
    if (packet.kind === 'delim') {
      sections.push([]);
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    sections[sections.length - 1]?.push(line);
    if (sections.length === 1) {
      const equals = line.indexOf('=');
      if (equals > 0) request.keys.set(line.slice(0, equals), line.slice(equals + 1));
      if (line.startsWith('command=')) request.command = line.slice('command='.length);
      continue;
    }
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line === 'done') request.done = true;
    else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
  }
  return request;
}

function lsRefsAnswer(repo: Repo, request: V2Request): Buffer {
  const prefixes = request.prefixes;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = repo.tip();
  if (keep('HEAD')) {
    if (head !== undefined) {
      parts.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let suffix = '';
    if (name.startsWith('refs/tags/')) {
      const peeled = peelRef(repo, sha);
      if (peeled !== undefined) suffix += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${sha} ${name}${suffix}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function fetchAnswer(repo: Repo, request: V2Request): Buffer {
  const wants = [...new Set(request.wants)];
  const haves = [...new Set(request.haves)];
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  let included: Set<string>;

  if (request.deepen !== undefined && Number.isFinite(request.deepen) && request.deepen >= 1) {
    const walk = reachableDepth(repo, wants, request.deepen);
    included = walk.out;
    const boundary = new Set(walk.boundary);
    const existing = new Set(request.shallow);
    for (const sha of walk.boundary) if (!existing.has(sha)) shallowLines.push(sha);
    for (const sha of existing) if (!boundary.has(sha)) unshallowLines.push(sha);
  } else {
    included = reachable(repo, wants);
  }

  if (haves.length > 0) {
    const held = request.shallow.length > 0
      ? reachableStopping(repo, haves, new Set(request.shallow))
      : reachable(repo, haves);
    for (const sha of held) included.delete(sha);
  }

  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (haves.length > 0 && request.done) {
    const known = haves.find((sha) => repo.object(sha) !== undefined);
    if (known !== undefined) parts.push(pktLine(`ACK ${known}\n`));
    else parts.push(pktLine('NAK\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(DELIM_PKT);

  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of shallowLines) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallowLines) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(DELIM_PKT);
  }

  if (included.size > 0) {
    const objects: GitObject[] = [];
    for (const sha of included) {
      const object = repo.object(sha);
      if (object !== undefined) objects.push(object);
    }
    const pack = writePack(objects);
    parts.push(pktLine('packfile\n'));
    for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushBody {
  commands: PushCommand[];
  capabilities: Set<string>;
  pack: Buffer;
}

function parsePush(body: Buffer): PushBody {
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  let first = true;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length);
    offset += length;
    if (first) {
      first = false;
      const nul = payload.indexOf(0);
      const commandText = nul >= 0 ? payload.subarray(0, nul) : payload;
      if (nul >= 0) {
        for (const token of payload.subarray(nul + 1).toString('utf8').split(' ')) {
          if (token !== '') capabilities.add(token.split('=')[0] as string);
        }
      }
      const parsed = commandText.toString('utf8').replace(/\n$/, '');
      const [oldOid, newOid, ref] = parsed.split(' ');
      if (oldOid !== undefined && newOid !== undefined && ref !== undefined) commands.push({ oldOid, newOid, ref });
    } else {
      const parsed = payload.toString('utf8').replace(/\n$/, '');
      const [oldOid, newOid, ref] = parsed.split(' ');
      if (oldOid !== undefined && newOid !== undefined && ref !== undefined) commands.push({ oldOid, newOid, ref });
    }
  }
  return { commands, capabilities, pack: body.subarray(offset) };
}

function reportStream(lines: readonly string[]): Buffer {
  return Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH_PKT]);
}

function receivePackAnswer(repo: Repo, body: Buffer): Buffer {
  const { commands, capabilities, pack } = parsePush(body);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';

  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (sha) => repo.object(sha));
      for (const object of objects) {
        if (repo.object(object.sha) === undefined) repo.objects.set(object.sha, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  report.push(`unpack ${unpackDetail}\n`);

  for (const command of commands) {
    if (unpackOk === false) {
      report.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      const current = repo.refs.get(command.ref);
      if (current === undefined) {
        report.push(`ng ${command.ref} not found\n`);
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push(`ng ${command.ref} stale info\n`);
        continue;
      }
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    if (repo.object(command.newOid) === undefined) {
      report.push(`ng ${command.ref} missing necessary objects\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${command.ref} already exists\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    if (current === undefined) {
      report.push(`ng ${command.ref} not found\n`);
      continue;
    }
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (!repo.history(command.newOid, 100_000).includes(command.oldOid)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }

  if (repo.tip() === undefined && repo.refs.size === 0) {
    // an empty push leaves the default branch unborn; nothing else to do
  }

  const stream = reportStream(report);
  const sideband = capabilities.has('side-band-64k');
  if (!sideband) return stream;
  return Buffer.concat([...sidebandChunks(stream), FLUSH_PKT]);
}

// ---------------------------------------------------------------- routing

export function handleGitHttp(forge: Forge, method: string, url: URL, body: Buffer, protocolV2 = false): GitAnswer | null {
  const target = parseTarget(url.pathname, url.searchParams);
  if (target === null) return null;
  const repo = forge.repo(target.owner, target.repo);
  if (repo === undefined) return notFound();
  const contentType = `application/x-${target.service}-${target.action === 'info' ? 'advertisement' : 'result'}`;

  if (method === 'GET' && target.action === 'info') {
    return result(contentType, advertisement(repo, target.service, protocolV2));
  }

  if (method !== 'POST') {
    return { status: 405, contentType: 'text/plain; charset=utf-8', headers: {}, body: Buffer.from('method not allowed\n', 'utf8') };
  }

  if (target.action === 'receive') {
    return result(contentType, receivePackAnswer(repo, body));
  }

  const request = parseV2(body);
  if (request === null || request.command === '') {
    return { status: 400, contentType: 'text/plain; charset=utf-8', headers: {}, body: Buffer.from('expected a pkt-line request\n', 'utf8') };
  }
  if (request.command === 'ls-refs') return result(contentType, lsRefsAnswer(repo, request));
  if (request.command === 'fetch') return result(contentType, fetchAnswer(repo, request));
  return { status: 400, contentType: 'text/plain; charset=utf-8', headers: {}, body: Buffer.from('unknown command\n', 'utf8') };
}
