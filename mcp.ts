// The Model Context Protocol endpoint: revision 2026-07-28's server/discover, the legacy initialize
// handshake, tools/list with the six repository/issue/pull tools, tools/call with JSON-RPC errors
// and tool-level isError results, and JSON-RPC parse errors. Stateless over the shared Forge.
import { encodeNodeId } from './lib.ts';
import { Forge, type Issue, type Pull, type Repo, type User } from './store.ts';

export interface McpAnswer {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
}

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: schema({
      owner: stringProperty('The login that will own the repository (defaults to the token user).'),
      name: stringProperty('The repository name.'),
      description: stringProperty('A short description of the repository.'),
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: schema({
      owner: stringProperty('The repository owner login.'),
      repo: stringProperty('The repository name.'),
    }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: schema({
      owner: stringProperty('The repository owner login.'),
      repo: stringProperty('The repository name.'),
      title: stringProperty('The issue title.'),
      body: stringProperty('The issue body.'),
    }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: schema({
      owner: stringProperty('The repository owner login.'),
      repo: stringProperty('The repository name.'),
      state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
    }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema({
      owner: stringProperty('The repository owner login.'),
      repo: stringProperty('The repository name.'),
      title: stringProperty('The pull request title.'),
      body: stringProperty('The pull request body.'),
      head: stringProperty('The source branch name.'),
      base: stringProperty('The target branch name.'),
    }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request (squash by default), closing it.',
    inputSchema: schema({
      owner: stringProperty('The repository owner login.'),
      repo: stringProperty('The repository name.'),
      pull_number: { type: 'integer', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'merge, squash or rebase.', enum: ['merge', 'squash', 'rebase'] },
    }, ['owner', 'repo', 'pull_number']),
  },
];

function json(status: number, body: unknown): McpAnswer {
  return { status, contentType: 'application/json; charset=utf-8', headers: {}, body: JSON.stringify(body) };
}

function rpcResult(id: unknown, result: unknown): McpAnswer {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, text: string, data?: unknown): McpAnswer {
  return json(200, { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message: text } : { code, message: text, data } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: encodeNodeId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.ownerLogin, id: repo.owner.id, type: 'User' },
    private: repo.privateRepo,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.fullName}`,
    clone_url: `/${repo.fullName}.git`,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeNodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.user.login },
    repository: repo.fullName,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: encodeNodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: repo.tip(pull.head) ?? pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    user: { login: pull.user.login },
    repository: repo.fullName,
  };
}

interface ToolOutcome {
  value: unknown;
  isError: boolean;
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], structuredContent: value, isError };
}

function ownerOf(forge: Forge, args: Record<string, unknown>): User {
  const login = typeof args.owner === 'string' && args.owner !== '' ? args.owner : forge.viewer.login;
  return forge.user(login) ?? forge.viewer;
}

function repoOf(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : forge.viewer.login;
  const name = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  return forge.repo(owner, name);
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome | null {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      const description = typeof args.description === 'string' ? args.description : null;
      const owner = ownerOf(forge, args);
      const created = forge.createRepo(owner, repoName, description, args.private === true);
      if (created.repo === undefined) return { value: { error: created.error ?? 'repository creation failed' }, isError: true };
      return { value: repoView(created.repo), isError: false };
    }
    case 'get_repo': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return { value: { error: 'repository not found' }, isError: true };
      return { value: repoView(repo), isError: false };
    }
    case 'create_issue': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return { value: { error: 'repository not found' }, isError: true };
      if (typeof args.title !== 'string' || args.title === '') return { value: { error: 'title is required' }, isError: true };
      const user = ownerOf(forge, args);
      const issue = repo.createIssue(user, args.title, typeof args.body === 'string' ? args.body : '', []);
      return { value: issueView(repo, issue), isError: false };
    }
    case 'list_issues': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return { value: { error: 'repository not found' }, isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state).map((issue) => issueView(repo, issue));
      return { value: issues, isError: false };
    }
    case 'create_pull_request': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return { value: { error: 'repository not found' }, isError: true };
      if (typeof args.title !== 'string' || typeof args.head !== 'string' || typeof args.base !== 'string') return { value: { error: 'title, head and base are required' }, isError: true };
      const headRaw = args.head;
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const pull = repo.createPull(ownerOf(forge, args), args.title, typeof args.body === 'string' ? args.body : '', head, args.base);
      if (pull === null) return { value: { error: 'the head or base branch does not exist' }, isError: true };
      return { value: pullView(repo, pull), isError: false };
    }
    case 'merge_pull_request': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return { value: { error: 'repository not found' }, isError: true };
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return { value: { error: 'pull request not found' }, isError: true };
      const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
      const result = repo.mergePull(pull, method);
      if ('missing' in result) return { value: { error: 'pull request is not mergeable' }, isError: true };
      if ('conflict' in result) return { value: { error: 'pull request has conflicts' }, isError: true };
      return { value: { sha: result.sha, merged: true, message: result.message, number: pull.number, state: pull.state }, isError: false };
    }
    default:
      return null;
  }
}

function handleMessage(forge: Forge, message: unknown): { answer: McpAnswer | null; notification: boolean } {
  if (!isRecord(message)) return { answer: rpcError(null, -32600, 'Invalid Request'), notification: false };
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = isRecord(message.params) ? message.params : {};
  const isNotification = id === undefined || id === null;
  if (method === '') return { answer: rpcError(id, -32600, 'Invalid Request'), notification: isNotification };
  switch (method) {
    case 'server/discover':
      return {
        answer: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: PROTOCOL_VERSIONS.slice(),
          capabilities: { tools: { listChanged: false } },
          instructions: 'A GitHub-compatible forge exposed over REST v3, GraphQL v4, git smart HTTP and MCP.',
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
        notification: false,
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const chosen = PROTOCOL_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return {
        answer: rpcResult(id, { protocolVersion: chosen, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO }),
        notification: false,
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { answer: null, notification: true };
    case 'ping':
      return { answer: rpcResult(id, {}), notification: false };
    case 'tools/list':
      return { answer: rpcResult(id, { tools: TOOLS }), notification: false };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return { answer: rpcError(id, -32602, `Unknown tool: ${toolName}`), notification: false };
      const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
      for (const key of required) {
        if (!(key in args) || args[key] === undefined || args[key] === null) {
          return { answer: rpcError(id, -32602, `Invalid params: missing required argument ${key}`), notification: false };
        }
      }
      const outcome = callTool(forge, toolName, args);
      if (outcome === null) return { answer: rpcError(id, -32602, `Unknown tool: ${toolName}`), notification: false };
      return { answer: rpcResult(id, textResult(outcome.value, outcome.isError)), notification: false };
    }
    default:
      return { answer: rpcError(id, -32601, `Method not found: ${method}`), notification: false };
  }
}

export function handleMcp(forge: Forge, text: string, method: string, authorization: string | null): McpAnswer | null {
  if (method === 'DELETE') return null;
  if (method === 'GET') return null;
  if (method !== 'POST') return json(405, { message: 'Method Not Allowed' });

  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON' } });
  }
  if (parsed === undefined) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: empty body' } });

  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const message of parsed) {
      const handled = handleMessage(forge, message);
      if (handled.answer !== null) {
        const body = JSON.parse(handled.answer.body) as unknown;
        if (authorization === null && isRecord(message) && typeof message.method === 'string' && message.method.startsWith('tools/')) {
          return json(401, { message: 'Requires authentication' });
        }
        answers.push(body);
      }
    }
    return json(200, answers);
  }

  const isToolRequest = isRecord(parsed) && typeof parsed.method === 'string' && parsed.method.startsWith('tools/');
  if (authorization === null || !/^Bearer\s+\S+/i.test(authorization.trim())) {
    if (isToolRequest) return json(401, { message: 'Requires authentication' });
  }
  const handled = handleMessage(forge, parsed);
  if (handled.answer === null) return null;
  return handled.answer;
}
