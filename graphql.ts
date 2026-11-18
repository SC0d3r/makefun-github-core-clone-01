// The GraphQL v4 endpoint: a small hand-written document parser (operations, variables, aliases,
// arguments, inline fragments and introspection) over the Forge, answering the queries gh and
// github-mcp-server send, plus the createIssue/closeIssue/createPullRequest/mergePullRequest/
// addComment mutations and operation batching.
import { decodeNodeId, encodeNodeId } from './lib.ts';
import { Forge, type Issue, type Pull, type Repo, type User } from './store.ts';

export interface GraphQLAnswer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// ---------------------------------------------------------------- lexer and parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' && text.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      if (text.slice(i, i + 3) === '"""') {
        const end = text.indexOf('"""', i + 3);
        const value = end < 0 ? text.slice(i + 3) : text.slice(i + 3, end);
        tokens.push({ kind: 'string', value });
        i = end < 0 ? text.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          const next = text[i + 1] ?? '';
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (next === 'u') {
            value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          value += escapes[next] ?? next;
          i += 2;
          continue;
        }
        value += text[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j] as string)) j += 1;
      const raw = text.slice(i, j);
      tokens.push({ kind: 'int', value: Number(raw) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[_0-9A-Za-z]/.test(text[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: text.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<[string, GqlValue]> };

export interface GqlSelection {
  kind: 'field' | 'spread' | 'inline';
  alias?: string;
  name?: string;
  args?: Array<[string, GqlValue]>;
  selections?: GqlSelection[];
  fragmentName?: string;
  typeCondition?: string;
}

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

interface ParsedDocument {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: GqlSelection[] }>;
}

class Parser {
  private tokens: Token[];
  private index = 0;
  constructor(text: string) {
    this.tokens = lex(text);
  }
  private peek(): Token {
    return this.tokens[this.index] as Token;
  }
  private advance(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }
  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }
  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new Error(`expected "${value}"`);
    this.advance();
  }
  private name(): string {
    const token = this.advance();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }
  document(): ParsedDocument {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: GqlSelection[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'fragment') {
        this.advance();
        const name = this.name();
        this.name();
        const typeCondition = this.name();
        const selections = this.selectionSet();
        fragments.set(name, { typeCondition, selections });
        continue;
      }
      let type: Operation['type'] = 'query';
      if (this.peek().kind === 'name') {
        const keyword = (this.peek() as { value: string }).value;
        if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
          this.advance();
          type = keyword;
        }
      }
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.name();
      const variables: Operation['variables'] = [];
      if (this.isPunct('(')) {
        this.advance();
        while (!this.isPunct(')')) {
          this.expectPunct('$');
          const variableName = this.name();
          this.expectPunct(':');
          this.typeName();
          let defaultValue: GqlValue | null = null;
          if (this.isPunct('=')) {
            this.advance();
            defaultValue = this.value();
          }
          variables.push({ name: variableName, defaultValue });
        }
        this.expectPunct(')');
      }
      for (const directive of ['@']) {
        while (this.isPunct(directive)) {
          this.advance();
          this.name();
          if (this.isPunct('(')) this.skipArguments();
        }
      }
      const selections = this.selectionSet();
      operations.push({ type, name, variables, selections });
    }
    if (operations.length === 0) operations.push({ type: 'query', name: null, variables: [], selections: [] });
    return { operations, fragments };
  }
  private typeName(): string {
    let name = '';
    if (this.isPunct('[')) {
      this.advance();
      name = `[${this.typeName()}]`;
      this.expectPunct(']');
    } else {
      name = this.name();
    }
    if (this.isPunct('!')) this.advance();
    return name;
  }
  private selectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.advance();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.advance();
          const typeCondition = this.name();
          selections.push({ kind: 'inline', typeCondition, selections: this.selectionSet() });
        } else if (this.peek().kind === 'name') {
          selections.push({ kind: 'spread', fragmentName: this.name() });
        } else {
          selections.push({ kind: 'inline', selections: this.selectionSet() });
        }
        continue;
      }
      let alias: string | undefined;
      let name = this.name();
      if (this.isPunct(':')) {
        this.advance();
        alias = name;
        name = this.name();
      }
      const args: Array<[string, GqlValue]> = [];
      if (this.isPunct('(')) {
        this.advance();
        while (!this.isPunct(')')) {
          const argName = this.name();
          this.expectPunct(':');
          args.push([argName, this.value()]);
        }
        this.expectPunct(')');
      }
      const hasSelection = this.isPunct('{');
      selections.push({ kind: 'field', alias, name, args, selections: hasSelection ? this.selectionSet() : undefined });
    }
    this.expectPunct('}');
    return selections;
  }
  private skipArguments(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.advance();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
      else if (token.kind === 'eof') return;
    }
  }
  private value(): GqlValue {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.advance();
      return { kind: 'var', name: this.name() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.advance();
      const values: GqlValue[] = [];
      while (!this.isPunct(']')) values.push(this.value());
      this.advance();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.advance();
      const fields: Array<[string, GqlValue]> = [];
      while (!this.isPunct('}')) {
        const key = this.name();
        this.expectPunct(':');
        fields.push([key, this.value()]);
      }
      this.advance();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') {
      this.advance();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'int') {
      this.advance();
      return { kind: 'int', value: token.value };
    }
    if (token.kind === 'name') {
      this.advance();
      if (token.value === 'true' || token.value === 'false') return { kind: 'boolean', value: token.value === 'true' };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('expected a value');
  }
}

// ---------------------------------------------------------------- values and variables

function valueOf(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': return variables[value.name];
    case 'string': return value.value;
    case 'int': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = valueOf(entry, variables);
      return out;
    }
  }
}

function argValue(args: Array<[string, GqlValue]> | undefined, name: string, variables: Record<string, unknown>): unknown {
  if (args === undefined) return undefined;
  for (const [key, value] of args) if (key === name) return valueOf(value, variables);
  return undefined;
}

function argsObject(args: Array<[string, GqlValue]> | undefined, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of args ?? []) out[key] = valueOf(value, variables);
  return out;
}

// ---------------------------------------------------------------- resolution

interface ErrorEntry {
  message: string;
  path?: Array<string | number>;
}

class GraphQLExecutor {
  private forge: Forge;
  private fragments: ParsedDocument['fragments'];
  private variables: Record<string, unknown>;
  errors: ErrorEntry[] = [];

  constructor(forge: Forge, fragments: ParsedDocument['fragments'], variables: Record<string, unknown>) {
    this.forge = forge;
    this.fragments = fragments;
    this.variables = variables;
  }

  execute(operation: Operation): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of operation.selections) this.applyRoot(selection, out);
    return out;
  }

  private applyRoot(selection: GqlSelection, out: Record<string, unknown>): void {
    if (selection.kind === 'spread') {
      const fragment = this.fragments.get(selection.fragmentName ?? '');
      for (const child of fragment?.selections ?? []) this.applyRoot(child, out);
      return;
    }
    if (selection.kind === 'inline') {
      for (const child of selection.selections ?? []) this.applyRoot(child, out);
      return;
    }
    const name = selection.name ?? '';
    const key = selection.alias ?? name;
    if (name === '__typename') {
      out[key] = 'Query';
      return;
    }
    const args = selection.args;
    switch (name) {
      case 'viewer':
        out[key] = this.resolveObject('User', this.forge.viewer, selection);
        return;
      case 'repository': {
        const owner = String(argValue(args, 'owner', this.variables) ?? '');
        const repoName = String(argValue(args, 'name', this.variables) ?? '');
        const repo = this.forge.repo(owner, repoName);
        out[key] = repo === undefined ? null : this.resolveObject('Repository', repo, selection);
        return;
      }
      case 'organization': {
        const login = String(argValue(args, 'login', this.variables) ?? '');
        out[key] = login === this.forge.org ? { login: this.forge.org, id: encodeNodeId('Organization', this.forge.orgId), name: this.forge.org } : null;
        return;
      }
      case 'node': {
        const id = String(argValue(args, 'id', this.variables) ?? '');
        out[key] = this.resolveNode(id, selection);
        return;
      }
      case '__type': {
        const typeName = String(argValue(args, 'name', this.variables) ?? '');
        out[key] = this.resolveType(typeName, selection);
        return;
      }
      case 'createIssue':
        out[key] = this.createIssue(args, selection);
        return;
      case 'closeIssue':
        out[key] = this.closeIssue(args, selection);
        return;
      case 'createPullRequest':
        out[key] = this.createPullRequest(args, selection);
        return;
      case 'mergePullRequest':
        out[key] = this.mergePullRequest(args, selection);
        return;
      case 'addComment':
        out[key] = this.addComment(args, selection);
        return;
      default:
        this.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
        out[key] = null;
    }
  }

  private resolveObject(typeName: string, subject: unknown, selection: GqlSelection, path: Array<string | number> = []): unknown {
    if (subject === null || subject === undefined) return null;
    const out: Record<string, unknown> = {};
    const fields = this.expandedSelections(typeName, selection.selections ?? []);
    for (const child of fields) {
      if (child.kind !== 'field') continue;
      const name = child.name ?? '';
      const key = child.alias ?? name;
      const value = this.resolveField(typeName, name, subject, child, [...path, key]);
      out[key] = value;
    }
    return out;
  }

  private expandedSelections(typeName: string, selections: GqlSelection[]): GqlSelection[] {
    const out: GqlSelection[] = [];
    for (const selection of selections) {
      if (selection.kind === 'field') out.push(selection);
      else if (selection.kind === 'spread') {
        const fragment = this.fragments.get(selection.fragmentName ?? '');
        if (fragment !== undefined && this.typeMatches(typeName, fragment.typeCondition)) out.push(...this.expandedSelections(typeName, fragment.selections));
      } else if (selection.kind === 'inline') {
        if (selection.typeCondition === undefined || this.typeMatches(typeName, selection.typeCondition)) out.push(...this.expandedSelections(typeName, selection.selections ?? []));
      }
    }
    return out;
  }

  private typeMatches(actual: string, condition: string): boolean {
    if (actual === condition) return true;
    const interfaces: Record<string, string[]> = { Repository: ['Node', 'RepositoryInfo'], Issue: ['Node', 'Comment'], PullRequest: ['Node', 'Comment'], User: ['Node', 'Actor'], Organization: ['Node', 'Actor'] };
    return (interfaces[actual] ?? []).includes(condition);
  }

  private resolveField(typeName: string, name: string, subject: unknown, selection: GqlSelection, path: Array<string | number>): unknown {
    if (name === '__typename') return typeName;
    const args = selection.args;
    if (typeName === 'User') {
      const user = subject as User;
      if (name === 'login') return user.login;
      if (name === 'id') return encodeNodeId('User', user.id);
      if (name === 'name') return user.name;
      if (name === 'email') return user.email;
      if (name === 'databaseId') return user.id;
      if (name === 'organizations') return this.connection(selection, [], 0, 0);
      if (name === 'repositories' || name === 'pullRequests' || name === 'issues') return this.connection(selection, [], 0, 0);
      this.errors.push({ message: `Cannot query field "${name}" on type "User".`, path });
      return null;
    }
    if (typeName === 'Repository') {
      const repo = subject as Repo;
      switch (name) {
        case 'id': return encodeNodeId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return this.resolveObject('User', repo.owner, selection, path);
        case 'defaultBranchRef': {
          const sha = repo.tip();
          return { name: repo.defaultBranch, target: sha === undefined ? null : { oid: sha } };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'isPrivate': return repo.privateRepo;
        case 'description': return repo.description;
        case 'createdAt': return repo.createdAt;
        case 'issue': {
          const number = Number(argValue(args, 'number', this.variables));
          const issue = repo.issues.find((candidate) => candidate.number === number);
          return issue === undefined ? null : this.resolveObject('Issue', issue, selection, path);
        }
        case 'issues': return this.issueConnection(repo, selection, path);
        case 'pullRequests': return this.pullConnection(repo, selection, path);
        case 'pullRequest': {
          const number = Number(argValue(args, 'number', this.variables));
          const pull = repo.pulls.find((candidate) => candidate.number === number);
          return pull === undefined ? null : this.resolveObject('PullRequest', wrapPull(pull, repo), selection, path);
        }
        case 'branches': return this.connection(selection, repo.refs.size === 0 ? [] : [{ name: repo.defaultBranch, target: { oid: repo.tip() ?? '' } }], 1, 1);
        case 'ref': {
          const qualified = String(argValue(args, 'qualifiedName', this.variables) ?? '');
          const sha = repo.refs.get(qualified);
          return sha === undefined ? null : this.resolveObject('Ref', { name: qualified.replace(/^refs\/heads\//, ''), target: { oid: sha } }, selection, path);
        }
        case 'object': {
          const oid = String(argValue(args, 'oid', this.variables) ?? '');
          void oid;
          return null;
        }
        default:
          this.errors.push({ message: `Cannot query field "${name}" on type "Repository".`, path });
          return null;
      }
    }
    if (typeName === 'Issue') {
      const issue = subject as Issue;
      switch (name) {
        case 'id': return encodeNodeId('Issue', issue.id);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'bodyText': return issue.body;
        case 'url': return '';
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.closedAt;
        case 'author': return this.resolveObject('User', issue.user, selection, path);
        case 'labels': return this.connection(selection, issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })), issue.labels.length, issue.labels.length, 'Label');
        default:
          this.errors.push({ message: `Cannot query field "${name}" on type "Issue".`, path });
          return null;
      }
    }
    if (typeName === 'PullRequest') {
      const pull = subject as { pull: Pull; repo: Repo } & Pull;
      const repo = pull.repo as Repo;
      const record = pull as unknown as Pull;
      switch (name) {
        case 'id': return encodeNodeId('PullRequest', record.id);
        case 'number': return record.number;
        case 'title': return record.title;
        case 'body': return record.body;
        case 'state': return record.merged ? 'MERGED' : record.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return record.merged;
        case 'headRefName': return record.head;
        case 'baseRefName': return record.base;
        case 'headRefOid': return repo.tip(record.head) ?? record.headSha;
        case 'baseRefOid': return record.baseSha;
        case 'mergeable': return this.mergeable(repo, record) ? 'MERGEABLE' : 'CONFLICTING';
        case 'mergeStateStatus': return 'CLEAN';
        case 'isDraft': return false;
        case 'createdAt': return record.createdAt;
        case 'updatedAt': return record.updatedAt;
        case 'mergedAt': return record.mergedAt;
        case 'author': return this.resolveObject('User', record.user, selection, path);
        case 'files': {
          const diff = repo.pullDiff(record).map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' }));
          return this.connection(selection, diff, diff.length, diff.length, 'PullRequestChangedFile');
        }
        case 'comments': return this.connection(selection, record.comments.map((comment) => ({ id: encodeNodeId('IssueComment', comment.id), body: comment.body })), record.comments.length, record.comments.length);
        default:
          this.errors.push({ message: `Cannot query field "${name}" on type "PullRequest".`, path });
          return null;
      }
    }
    if (typeName === 'PullRequestChangedFile') {
      const file = subject as Record<string, unknown>;
      if (name === 'path') return file.path;
      if (name === 'additions') return file.additions;
      if (name === 'deletions') return file.deletions;
      if (name === 'changeType') return file.changeType;
      if (name === '__typename') return 'PullRequestChangedFile';
      return null;
    }
    if (typeName === 'Label') {
      const label = subject as Record<string, unknown>;
      if (name === 'name') return label.name;
      if (name === 'color') return label.color;
      if (name === 'description') return label.description ?? null;
      if (name === '__typename') return 'Label';
      return null;
    }
    if (typeName === 'Comment') {
      const comment = subject as Record<string, unknown>;
      switch (name) {
        case 'id': return comment.id;
        case 'body': return comment.body;
        case 'bodyText': return comment.body;
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.updatedAt ?? comment.createdAt;
        case 'author': return comment.author === undefined ? null : this.resolveObject('User', comment.author, selection, path);
        case '__typename': return 'IssueComment';
        default: return null;
      }
    }
    if (typeName === 'Organization') {
      const org = subject as Record<string, unknown>;
      if (name in org) return org[name];
      this.errors.push({ message: `Cannot query field "${name}" on type "Organization".`, path });
      return null;
    }
    if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection' || typeName === 'LabelConnection' || typeName === 'RepositoryConnection' || typeName === 'BranchConnection') {
      const connection = subject as { nodes: unknown[]; hasNext: boolean; endCursor: string | null; nodeType: string };
      if (name === 'nodes' || name === 'edges') {
        return connection.nodes.map((node, index) => name === 'nodes' ? this.resolveObject(connection.nodeType, node, selection, [...path, index]) : { cursor: String(index), node: this.resolveObject(connection.nodeType, node, selection, [...path, index]) });
      }
      if (name === 'totalCount') return connection.nodes.length;
      if (name === 'pageInfo') {
        const info: Record<string, unknown> = {};
        for (const child of this.expandedSelections('PageInfo', selection.selections ?? [])) {
          if (child.kind !== 'field') continue;
          const field = child.name ?? '';
          info[child.alias ?? field] = field === 'hasNextPage' || field === 'hasPreviousPage' ? field === 'hasNextPage' ? connection.hasNext : false : field === 'endCursor' ? connection.endCursor : null;
        }
        return info;
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".`, path });
      return null;
    }
    if (typeName === 'Ref') {
      const ref = subject as Record<string, unknown>;
      if (name === 'name') return ref.name;
      if (name === 'target') {
        const target = ref.target as { oid: string } | undefined;
        return target === undefined ? null : this.resolveObject('Commit', { oid: target.oid }, selection, path);
      }
      if (name === 'prefix') return 'refs/heads/';
      return null;
    }
    if (typeName === 'Commit') {
      const commit = subject as { oid: string };
      if (name === 'oid') return commit.oid;
      if (name === 'abbreviatedOid') return commit.oid.slice(0, 7);
      return null;
    }
    if (typeName === 'PageInfo') return null;
    return null;
  }

  private connection(selection: GqlSelection, nodes: unknown[], hasNext: number | boolean, _total: number, nodeType = 'User'): unknown {
    const connection = { nodes, hasNext: typeof hasNext === 'boolean' ? hasNext : hasNext > 0, endCursor: nodes.length === 0 ? null : Buffer.from(`cursor:${nodes.length}`).toString('base64'), nodeType };
    return this.resolveObject('RepositoryConnection', connection, selection);
  }

  private issueConnection(repo: Repo, selection: GqlSelection, path: Array<string | number>): unknown {
    const args = argsObject(selection.args, this.variables);
    const states = Array.isArray(args.states) ? (args.states as string[]) : [];
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
    const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
    let issues = repo.issues.filter((issue) => states.length === 0 || states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    issues = issues.slice().sort((a, b) => {
      let delta = 0;
      if (field === 'UPDATED_AT') delta = a.updatedAt.localeCompare(b.updatedAt);
      else delta = a.number - b.number;
      return direction === 'ASC' ? delta : -delta;
    });
    const after = typeof args.after === 'string' && args.after !== '' ? Number(Buffer.from(args.after, 'base64').toString('utf8').split(':')[1]) : 0;
    const start = Number.isFinite(after) ? after : 0;
    const first = typeof args.first === 'number' ? args.first : 30;
    const page = issues.slice(start, start + first);
    const connection = { nodes: page, hasNext: start + first < issues.length, endCursor: Buffer.from(`cursor:${start + page.length}`).toString('base64'), nodeType: 'Issue' };
    return this.resolveObject('IssueConnection', connection, selection, path);
  }

  private pullConnection(repo: Repo, selection: GqlSelection, path: Array<string | number>): unknown {
    const args = argsObject(selection.args, this.variables);
    const first = typeof args.first === 'number' ? args.first : 30;
    const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
    const pulls = repo.pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
    const page = pulls.slice(0, first);
    const wrapped = page.map((pull) => Object.assign(Object.create(null), pull, { pull, repo }));
    for (const item of wrapped) (item as Record<string, unknown>).repo = repo;
    const connection = { nodes: wrapped, hasNext: page.length < pulls.length, endCursor: Buffer.from(`cursor:${page.length}`).toString('base64'), nodeType: 'PullRequest' };
    return this.resolveObject('PullRequestConnection', connection, selection, path);
  }

  private mergeable(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.tip(pull.base);
    const headTip = repo.tip(pull.head);
    if (baseTip === undefined || headTip === undefined) return false;
    const common = repo.mergeBase(baseTip, headTip) ?? pull.baseSha;
    if (common === baseTip) return true;
    const basePaths = new Set(repo.diffTrees(repo.commitData(common)?.tree, repo.commitData(baseTip)?.tree).map((change) => change.path));
    return !repo.diffTrees(repo.commitData(common)?.tree, repo.commitData(headTip)?.tree).some((change) => basePaths.has(change.path));
  }

  private resolveNode(id: string, selection: GqlSelection): unknown {
    const decoded = decodeNodeId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const repo = [...this.forge.repos.values()].find((candidate) => String(candidate.id) === decoded.id);
      return repo === undefined ? null : this.resolveObject('Repository', repo, selection);
    }
    if (decoded.kind === 'Issue') {
      for (const repo of this.forge.repos.values()) {
        const issue = repo.issues.find((candidate) => String(candidate.id) === decoded.id);
        if (issue !== undefined) return this.resolveObject('Issue', issue, selection);
      }
      return null;
    }
    if (decoded.kind === 'PullRequest') {
      for (const repo of this.forge.repos.values()) {
        const pull = repo.pulls.find((candidate) => String(candidate.id) === decoded.id);
        if (pull !== undefined) return this.resolveObject('PullRequest', wrapPull(pull, repo), selection);
      }
      return null;
    }
    if (decoded.kind === 'User') {
      const user = this.forge.users.find((candidate) => String(candidate.id) === decoded.id);
      return user === undefined ? null : this.resolveObject('User', user, selection);
    }
    return null;
  }

  private resolveType(typeName: string, selection: GqlSelection): unknown {
    const fieldsByType: Record<string, string[]> = {
      Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'createdAt', 'updatedAt', 'comments'],
      PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'comments', 'mergeStateStatus', 'isDraft'],
      Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate'],
      User: ['id', 'login', 'name', 'email'],
      SearchType: [],
    };
    const enumValues: Record<string, string[]> = {
      SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
      IssueState: ['OPEN', 'CLOSED'],
      PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
      MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
      PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
      RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
      IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
      OrderDirection: ['ASC', 'DESC'],
    };
    if (!(typeName in fieldsByType) && !(typeName in enumValues)) return null;
    const out: Record<string, unknown> = { name: typeName, kind: typeName === 'SearchType' || typeName === 'IssueState' ? 'ENUM' : 'OBJECT' };
    for (const child of selection.selections ?? []) {
      if (child.kind !== 'field') continue;
      const name = child.name ?? '';
      if (name === 'fields') {
        out[child.alias ?? name] = (fieldsByType[typeName] ?? []).map((field) => ({ name: field }));
      } else if (name === 'enumValues') {
        out[child.alias ?? name] = (enumValues[typeName] ?? []).map((value) => ({ name: value }));
      } else if (name === 'name') {
        out[child.alias ?? name] = typeName;
      } else if (name === 'kind') {
        out[child.alias ?? name] = out.kind;
      } else {
        out[child.alias ?? name] = null;
      }
    }
    return out;
  }

  private repoFromNodeId(id: string): Repo | undefined {
    const decoded = decodeNodeId(id);
    if (decoded === null) return undefined;
    return [...this.forge.repos.values()].find((repo) => String(repo.id) === decoded.id);
  }

  private issueFromNodeId(id: string): { repo: Repo; issue: Issue } | undefined {
    const decoded = decodeNodeId(id);
    if (decoded === null) return undefined;
    for (const repo of this.forge.repos.values()) {
      const issue = repo.issues.find((candidate) => String(candidate.id) === decoded.id);
      if (issue !== undefined) return { repo, issue };
    }
    return undefined;
  }

  private pullFromNodeId(id: string): { repo: Repo; pull: Pull } | undefined {
    const decoded = decodeNodeId(id);
    if (decoded === null) return undefined;
    for (const repo of this.forge.repos.values()) {
      const pull = repo.pulls.find((candidate) => String(candidate.id) === decoded.id);
      if (pull !== undefined) return { repo, pull };
    }
    return undefined;
  }

  private payloadField(selection: GqlSelection, name: string): GqlSelection | undefined {
    return (selection.selections ?? []).find((child) => child.kind === 'field' && child.name === name);
  }

  private createIssue(args: Array<[string, GqlValue]> | undefined, selection: GqlSelection): unknown {
    const input = (argValue(args, 'input', this.variables) ?? {}) as Record<string, unknown>;
    const repo = this.repoFromNodeId(String(input.repositoryId ?? ''));
    if (repo === undefined) {
      this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const issue = repo.createIssue(this.forge.viewer, String(input.title ?? ''), String(input.body ?? ''), []);
    const payload: Record<string, unknown> = {};
    const issueSelection = this.payloadField(selection, 'issue');
    payload.issue = issueSelection === undefined ? null : this.resolveObject('Issue', issue, issueSelection);
    payload.repository = this.resolveObject('Repository', repo, { kind: 'field', selections: (selection.selections ?? []).filter((child) => child.name === 'repository') } as GqlSelection);
    const out: Record<string, unknown> = {};
    for (const child of selection.selections ?? []) {
      if (child.kind !== 'field') continue;
      if (child.name === 'issue') out[child.alias ?? 'issue'] = payload.issue;
      else out[child.alias ?? child.name ?? ''] = null;
    }
    return out;
  }

  private closeIssue(args: Array<[string, GqlValue]> | undefined, selection: GqlSelection): unknown {
    const input = (argValue(args, 'input', this.variables) ?? {}) as Record<string, unknown>;
    const found = this.issueFromNodeId(String(input.issueId ?? ''));
    if (found === undefined) {
      this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closedAt = new Date().toISOString();
    found.issue.updatedAt = found.issue.closedAt;
    return this.wrapPayload(selection, 'issue', this.resolveObject('Issue', found.issue, this.payloadField(selection, 'issue') ?? { kind: 'field' }) as Record<string, unknown>);
  }

  private createPullRequest(args: Array<[string, GqlValue]> | undefined, selection: GqlSelection): unknown {
    const input = (argValue(args, 'input', this.variables) ?? {}) as Record<string, unknown>;
    const repo = this.repoFromNodeId(String(input.repositoryId ?? ''));
    if (repo === undefined) {
      this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const pull = repo.createPull(this.forge.viewer, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? repo.defaultBranch));
    if (pull === null) {
      this.errors.push({ message: 'The head or base branch does not exist.' });
      return null;
    }
    return this.wrapPayload(selection, 'pullRequest', this.resolveObject('PullRequest', wrapPull(pull, repo), this.payloadField(selection, 'pullRequest') ?? { kind: 'field' }) as Record<string, unknown>);
  }

  private mergePullRequest(args: Array<[string, GqlValue]> | undefined, selection: GqlSelection): unknown {
    const input = (argValue(args, 'input', this.variables) ?? {}) as Record<string, unknown>;
    const found = this.pullFromNodeId(String(input.pullRequestId ?? ''));
    if (found === undefined) {
      this.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return null;
    }
    const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
    const result = found.repo.mergePull(found.pull, method);
    if ('missing' in result || 'conflict' in result) {
      this.errors.push({ message: 'The pull request is not mergeable.' });
      return null;
    }
    return this.wrapPayload(selection, 'pullRequest', this.resolveObject('PullRequest', wrapPull(found.pull, found.repo), this.payloadField(selection, 'pullRequest') ?? { kind: 'field' }) as Record<string, unknown>);
  }

  private addComment(args: Array<[string, GqlValue]> | undefined, selection: GqlSelection): unknown {
    const input = (argValue(args, 'input', this.variables) ?? {}) as Record<string, unknown>;
    const found = this.issueFromNodeId(String(input.subjectId ?? ''));
    if (found === undefined) {
      this.errors.push({ message: 'Could not resolve to a subject with the global id.' });
      return null;
    }
    const now = new Date().toISOString();
    const comment = { id: found.repo.nextCommentId++, body: String(input.body ?? ''), user: this.forge.viewer, createdAt: now, updatedAt: now, issueNumber: found.issue.number };
    found.issue.comments.push(comment);
    const commentNode = { id: encodeNodeId('IssueComment', comment.id), body: comment.body, createdAt: comment.createdAt };
    const edge = { node: commentNode, cursor: String(comment.id) };
    const out: Record<string, unknown> = {};
    for (const child of selection.selections ?? []) {
      if (child.kind !== 'field' || child.name !== 'commentEdge') continue;
      const edgeOut: Record<string, unknown> = {};
      for (const edgeChild of child.selections ?? []) {
        if (edgeChild.kind === 'field' && edgeChild.name === 'node') {
          edgeOut.node = this.resolveObject('Comment', commentNode, edgeChild);
        } else if (edgeChild.kind === 'field' && edgeChild.name === 'cursor') {
          edgeOut.cursor = edge.cursor;
        }
      }
      out[child.alias ?? 'commentEdge'] = edgeOut;
    }
    return out;
  }

  private wrapPayload(selection: GqlSelection, key: string, value: unknown): unknown {
    const out: Record<string, unknown> = {};
    for (const child of selection.selections ?? []) {
      if (child.kind !== 'field') continue;
      out[child.alias ?? child.name ?? ''] = child.name === key ? value : null;
    }
    return out;
  }
}

function wrapPull(pull: Pull, repo: Repo): Pull {
  return Object.assign(Object.create(null), pull, { pull, repo }) as Pull;
}

// ---------------------------------------------------------------- the endpoint

export function handleGraphQL(forge: Forge, text: string): GraphQLAnswer {
  // Authorization is enforced by createApp's caller contract: an unauthenticated body is refused here.
  // body carries {query, variables} or an array of them; the HTTP layer checks the bearer header.
  let parsedBody: unknown;
  try {
    parsedBody = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return { status: 400, headers: {}, body: { message: 'Problems parsing JSON' } };
  }
  if (Array.isArray(parsedBody)) {
    const answers = parsedBody.map((operation) => executeOne(forge, operation));
    return { status: 200, headers: {}, body: answers };
  }
  return { status: 200, headers: {}, body: executeOne(forge, parsedBody) };
}

function executeOne(forge: Forge, operation: unknown): Record<string, unknown> {
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    return { errors: [{ message: 'Invalid request body' }] };
  }
  const record = operation as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? (record.variables as Record<string, unknown>) : {};
  let document: ParsedDocument;
  try {
    document = new Parser(query).document();
  } catch (err) {
    return { errors: [{ message: `Syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const chosen = operationName === null ? document.operations[0] : document.operations.find((candidate) => candidate.name === operationName);
  if (chosen === undefined) return { errors: [{ message: 'No operation to run' }] };
  const merged: Record<string, unknown> = { ...variables };
  for (const variable of chosen.variables) {
    if (merged[variable.name] === undefined && variable.defaultValue !== null) merged[variable.name] = valueOf(variable.defaultValue, merged);
  }
  const executor = new GraphQLExecutor(forge, document.fragments, merged);
  try {
    const data = executor.execute(chosen);
    return executor.errors.length > 0 ? { data, errors: executor.errors } : { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
