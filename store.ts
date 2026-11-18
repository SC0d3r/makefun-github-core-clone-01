// The in-memory forge: seeded identity (the wire scenario's viewer, users and organization), the
// repository model with real git objects, branches, issues, pulls, labels and comments, and the
// operations REST, GraphQL, MCP and the git transport all drive.
import {
  buildCommit,
  buildTree,
  encodeNodeId,
  objectId,
  parseCommit,
  parseTree,
  type CommitData,
  type GitObject,
  type GitType,
  type Signature,
  type TreeEntry,
} from './lib.ts';

// ---------------------------------------------------------------- the seeded scenario identity

const U64 = 0xffffffffffffffffn;

function fnv1a(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64;
  }
  return hash;
}

function mix(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}

class Stream {
  private state: bigint;
  constructor(label: string) {
    const seed = mix(0x6a09e667f3bcc909n ^ fnv1a(label));
    this.state = seed === 0n ? 0x6a09e667f3bcc909n : seed;
  }
  next(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64;
    x = (x ^ (x << 25n)) & U64;
    x = (x ^ (x >> 27n)) & U64;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64;
  }
  u32(): number {
    return Number(this.next() >> 32n);
  }
  int(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    const limit = 4294967296 - (4294967296 % maxExclusive);
    for (;;) {
      const value = this.u32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

const FIRST = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];
const ADJECTIVES = ['amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively', 'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat', 'vivid', 'warm', 'witty', 'young', 'zesty'];
const NOUNS = ['acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor', 'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven', 'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr'];

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User';
  siteAdmin: boolean;
}

function generateUsers(): User[] {
  const rng = new Stream('users');
  const used = new Set<string>();
  const users: User[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid`, type: 'User', siteAdmin: false });
  }
  return users;
}

function generateOrg(): string {
  const rng = new Stream('org');
  return `${rng.pick(ADJECTIVES)}-${rng.pick(NOUNS)}-org`;
}

// ---------------------------------------------------------------- model

export const DEFAULT_BRANCH = 'main';
const EPOCH = 1735689600;

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
  updatedAt: string;
  issueNumber: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  user: User;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export class Repo {
  id: number;
  owner: User;
  ownerLogin: string;
  name: string;
  description: string | null;
  privateRepo: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels = new Map<string, Label>();
  nextIssueNumber = 1;
  nextPullNumber = 1;
  nextIssueId: number;
  nextCommentId: number;
  clock: number;

  constructor(id: number, owner: User, name: string, description: string | null, privateRepo: boolean) {
    this.id = id;
    this.owner = owner;
    this.ownerLogin = owner.login;
    this.name = name;
    this.description = description;
    this.privateRepo = privateRepo;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdAt = new Date(EPOCH * 1000).toISOString();
    this.updatedAt = this.createdAt;
    this.nextIssueId = id * 1000 + 1;
    this.nextCommentId = id * 10000 + 1;
    this.clock = 0;
  }

  get fullName(): string {
    return `${this.ownerLogin}/${this.name}`;
  }

  stamp(): { iso: string; epoch: number } {
    this.clock += 1;
    const epoch = EPOCH + this.clock;
    return { iso: new Date(epoch * 1000).toISOString(), epoch };
  }

  offerObject(object: GitObject): string {
    const sha = objectId(object.type, object.data);
    if (!this.objects.has(sha)) this.objects.set(sha, object);
    return sha;
  }

  object(sha: string): GitObject | undefined {
    return this.objects.get(sha.toLowerCase());
  }

  ref(name: string): string | undefined {
    return this.refs.get(name.startsWith('refs/') ? name : `refs/heads/${name}`);
  }

  setRef(name: string, sha: string): void {
    this.refs.set(name.startsWith('refs/') ? name : `refs/heads/${name}`, sha);
  }

  deleteRef(name: string): void {
    this.refs.delete(name.startsWith('refs/') ? name : `refs/heads/${name}`);
  }

  tip(branch?: string): string | undefined {
    return this.ref(`refs/heads/${branch ?? this.defaultBranch}`);
  }

  /** Resolve a revision the API names: a full sha, a ref, or a branch name. */
  resolve(rev?: string): string | undefined {
    if (rev === undefined || rev === '') return this.tip();
    if (this.objects.has(rev.toLowerCase())) return rev.toLowerCase();
    const direct = this.ref(rev);
    if (direct !== undefined) return direct;
    if (this.refs.has(`refs/${rev}`)) return this.refs.get(`refs/${rev}`);
    return undefined;
  }

  commitData(sha: string): CommitData | undefined {
    const object = this.object(sha);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  treeEntries(sha: string): TreeEntry[] | undefined {
    const object = this.object(sha);
    if (object === undefined || object.type !== 'tree') return undefined;
    return parseTree(object.data);
  }

  treeAt(sha: string | undefined, path: string): { type: GitType; sha: string } | undefined {
    if (sha === undefined) return undefined;
    const parts = path.split('/').filter((part) => part !== '');
    let current = sha;
    let type: GitType = 'tree';
    for (let i = 0; i < parts.length; i += 1) {
      if (type !== 'tree') return undefined;
      const entries = this.treeEntries(current);
      if (entries === undefined) return undefined;
      const found = entries.find((entry) => entry.name === parts[i]);
      if (found === undefined) return undefined;
      current = found.sha;
      type = found.mode === '40000' || found.mode === '040000' ? 'tree' : 'blob';
    }
    return { type, sha: current };
  }

  flatten(treeSha: string | undefined, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
    if (treeSha === undefined) return out;
    for (const entry of this.treeEntries(treeSha) ?? []) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') this.flatten(entry.sha, path, out);
      else out.set(path, { sha: entry.sha, mode: entry.mode });
    }
    return out;
  }

  /** Write a tree that has `blobSha` at `path` (or removes it when null), rooted at `rootTree`. */
  applyPath(rootTree: string | undefined, path: string, blobSha: string | null): string {
    const parts = path.split('/').filter((part) => part !== '');
    const walk = (treeSha: string | undefined, index: number): string | undefined => {
      const name = parts[index] as string;
      const entries = treeSha === undefined ? [] : this.treeEntries(treeSha) ?? [];
      const rest = entries.filter((entry) => entry.name !== name);
      if (index === parts.length - 1) {
        if (blobSha !== null) rest.push({ mode: '100644', name, sha: blobSha });
        if (rest.length === 0) return undefined;
        return this.offerObject({ type: 'tree', data: buildTree(rest) });
      }
      const existing = entries.find((entry) => entry.name === name);
      const child = walk(existing !== undefined && (existing.mode === '40000' || existing.mode === '040000') ? existing.sha : undefined, index + 1);
      if (child !== undefined) rest.push({ mode: '40000', name, sha: child });
      if (rest.length === 0) return undefined;
      return this.offerObject({ type: 'tree', data: buildTree(rest) });
    };
    const result = walk(rootTree, 0);
    if (result !== undefined) return result;
    return this.offerObject({ type: 'tree', data: buildTree([]) });
  }

  signature(user: User, epoch: number): Signature {
    return { name: user.name, email: user.email, date: epoch, tz: '+0000' };
  }

  writeCommit(tree: string, parents: string[], message: string, author: User): { sha: string; epoch: number } {
    const when = this.stamp();
    const sig = this.signature(author, when.epoch);
    const data = buildCommit({ tree, parents, author: sig, committer: sig, message });
    const sha = this.offerObject({ type: 'commit', data });
    return { sha, epoch: when.epoch };
  }

  /** Commit a set of path writes/removals on a branch. Returns null when the branch has no base. */
  commitChanges(branch: string, changes: readonly { path: string; content: Buffer | null }[], message: string, author: User, options: { createFromDefault?: boolean } = {}): { commitSha: string; contentShas: Map<string, string> } | null {
    let tip = this.tip(branch);
    if (tip === undefined && branch !== this.defaultBranch && options.createFromDefault !== false) {
      const base = this.tip(this.defaultBranch);
      if (base !== undefined) {
        this.setRef(`refs/heads/${branch}`, base);
        tip = base;
      }
    }
    const parentCommit = tip === undefined ? undefined : this.commitData(tip);
    let rootTree = parentCommit?.tree;
    const contentShas = new Map<string, string>();
    for (const change of changes) {
      let blobSha: string | null = null;
      if (change.content !== null) {
        blobSha = this.offerObject({ type: 'blob', data: change.content });
        contentShas.set(change.path, blobSha);
      }
      rootTree = this.applyPath(rootTree, change.path, blobSha);
    }
    if (rootTree === undefined) return null;
    const parents = tip === undefined ? [] : [tip];
    const written = this.writeCommit(rootTree, parents, message, author);
    this.setRef(`refs/heads/${branch}`, written.sha);
    if (this.tip(this.defaultBranch) === undefined && branch === this.defaultBranch) this.setRef(`refs/heads/${this.defaultBranch}`, written.sha);
    return { commitSha: written.sha, contentShas };
  }

  /** The commits reachable from `sha`, newest first, breadth-first over parents. */
  history(sha: string, limit = 100): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const queue = [sha];
    while (queue.length > 0 && out.length < limit) {
      const next = queue.shift() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      const commit = this.commitData(next);
      if (commit === undefined) continue;
      out.push(next);
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** The first common commit of two histories, or undefined. */
  mergeBase(a: string, b: string): string | undefined {
    const ancestors = new Set(this.history(a, 10_000));
    for (const sha of this.history(b, 10_000)) if (ancestors.has(sha)) return sha;
    return undefined;
  }

  createIssue(user: User, title: string, body: string, labels: Label[]): Issue {
    const when = this.stamp();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: this.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: labels.slice(),
      user,
      createdAt: when.iso,
      updatedAt: when.iso,
      closedAt: null,
      comments: [],
    };
    this.issues.push(issue);
    return issue;
  }

  createPull(user: User, title: string, body: string, head: string, base: string): Pull | null {
    const headSha = this.tip(head);
    const baseSha = this.tip(base);
    if (headSha === undefined || baseSha === undefined) return null;
    const when = this.stamp();
    const pull: Pull = {
      id: this.id * 1000 + this.nextPullNumber + 500000,
      number: this.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      user,
      createdAt: when.iso,
      updatedAt: when.iso,
      comments: [],
    };
    this.pulls.push(pull);
    return pull;
  }

  /** The tree paths changed from `fromTree` to `toTree`, with status and line counts. */
  diffTrees(fromTree: string | undefined, toTree: string | undefined): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
    const before = this.flatten(fromTree);
    const after = this.flatten(toTree);
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> = [];
    for (const path of [...paths].sort()) {
      const oldEntry = before.get(path);
      const newEntry = after.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.sha === newEntry.sha) continue;
      const oldText = oldEntry === undefined ? '' : (this.object(oldEntry.sha)?.data.toString('utf8') ?? '');
      const newText = newEntry === undefined ? '' : (this.object(newEntry.sha)?.data.toString('utf8') ?? '');
      const counts = lineCounts(oldText, newText);
      if (oldEntry === undefined) out.push({ path, status: 'added', additions: counts.added, deletions: 0 });
      else if (newEntry === undefined) out.push({ path, status: 'removed', additions: 0, deletions: counts.removed });
      else out.push({ path, status: 'modified', additions: counts.added, deletions: counts.removed });
    }
    return out;
  }

  pullDiff(pull: Pull, headSha?: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
    const head = headSha ?? pull.headSha;
    const base = this.mergeBase(this.tip(pull.base) ?? pull.baseSha, head) ?? pull.baseSha;
    const baseTree = this.commitData(base)?.tree;
    const headTree = this.commitData(head)?.tree;
    return this.diffTrees(baseTree, headTree);
  }

  /** Merge a pull: squash head changes onto the base tip. Null when the pull is unknown. */
  mergePull(pull: Pull, method: string): { merged: true; sha: string; message: string } | { merged: false; conflict: true } | { merged: false; missing: true } {
    const baseTip = this.tip(pull.base);
    if (baseTip === undefined) return { merged: false, missing: true };
    const headTip = this.tip(pull.head);
    if (headTip === undefined) return { merged: false, missing: true };
    const common = this.mergeBase(baseTip, headTip) ?? pull.baseSha;
    const commonTree = this.commitData(common)?.tree;
    const baseTree = this.commitData(baseTip)?.tree;
    const headTree = this.commitData(headTip)?.tree;
    const headChanges = this.diffTrees(commonTree, headTree);
    const baseChanges = this.diffTrees(commonTree, baseTree);
    const basePaths = new Set(baseChanges.map((change) => change.path));
    const overlap = headChanges.some((change) => basePaths.has(change.path));
    if (overlap) return { merged: false, conflict: true };
    let tree = baseTree;
    for (const change of headChanges) {
      const source = change.status === 'removed' ? null : this.treeAt(headTree, change.path)?.sha ?? null;
      tree = this.applyPath(tree, change.path, source);
    }
    const message = method === 'squash' ? `${pull.title} (#${pull.number})\n\n${pull.body}` : `Merge pull request #${pull.number} from ${this.ownerLogin}/${pull.head}\n\n${pull.title}`;
    const written = this.writeCommit(tree, [baseTip], message, this.owner);
    this.setRef(`refs/heads/${pull.base}`, written.sha);
    const when = this.stamp();
    pull.merged = true;
    pull.state = 'closed';
    pull.headSha = headTip;
    pull.baseSha = baseTip;
    pull.mergedAt = when.iso;
    pull.mergeCommitSha = written.sha;
    pull.updatedAt = when.iso;
    return { merged: true, sha: written.sha, message: 'Pull request successfully merged' };
  }
}

function lineCounts(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 1, removed: 1 };
  const oldLines = before === '' ? [] : before.split('\n');
  const newLines = after === '' ? [] : after.split('\n');
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newLines) {
    const count = oldSet.get(line) ?? 0;
    if (count > 0) oldSet.set(line, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of oldSet.values()) removed += count;
  if (added === 0 && removed === 0) return { added: 1, removed: 1 };
  return { added, removed };
}

export class Forge {
  users: User[];
  viewer: User;
  teammate: User;
  stranger: User;
  org: string;
  orgId = 9000;
  repos = new Map<string, Repo>();
  nextRepoId = 100_000;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;

  constructor() {
    this.users = generateUsers();
    this.viewer = this.users[0] as User;
    this.teammate = this.users[1] as User;
    this.stranger = this.users[2] as User;
    this.org = generateOrg();
  }

  user(login: string): User | undefined {
    if (login === this.org) return undefined;
    return this.users.find((user) => user.login === login);
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  hasRepo(owner: string, name: string): boolean {
    return this.repos.has(`${owner}/${name}`);
  }

  createRepo(owner: User, name: string, description: string | null, privateRepo: boolean): { repo?: Repo; error?: string } {
    if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return { error: 'name is invalid' };
    if (this.repos.has(`${owner.login}/${name}`)) return { error: 'name already exists on this account' };
    const repo = new Repo(this.nextRepoId++, owner, name, description, privateRepo);
    this.repos.set(repo.fullName, repo);
    return { repo };
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.ownerLogin === owner);
  }

  requireRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  nodeId(kind: string, id: number | string): string {
    return encodeNodeId(kind, id);
  }
}
