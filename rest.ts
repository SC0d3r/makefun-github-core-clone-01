// The GitHub REST v3 surface: users and repositories, contents and git data, branches, commits,
// issues, comments, labels, collaborators, pulls with their files and merges, and GitHub's JSON
// error bodies. handleRest never throws: every route answers a status, headers and a JSON body.
import { buildTree, decodeBase64, encodeBase64, encodeNodeId } from './lib.ts';
import { DEFAULT_BRANCH, Forge, type Issue, type Label, type Pull, type Repo, type User } from './store.ts';

export interface RestAnswer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const NOT_FOUND: RestAnswer = { status: 404, headers: {}, body: { message: 'Not Found' } };

function answer(status: number, body: unknown, headers: Record<string, string> = {}): RestAnswer {
  return { status, headers, body };
}

function message(status: number, text: string, headers: Record<string, string> = {}): RestAnswer {
  return { status, headers, body: { message: text } };
}

export function isRestPath(pathname: string): boolean {
  return pathname === '/api/v3' || pathname.startsWith('/api/v3/');
}

function userJson(user: User, origin: string) {
  return {
    login: user.login,
    id: user.id,
    node_id: encodeNodeId('User', user.id),
    avatar_url: `${origin}/avatars/${user.login}.png`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${user.login}`,
    html_url: `${origin}/${user.login}`,
    type: 'User',
    site_admin: user.siteAdmin,
  };
}

function repoJson(repo: Repo, origin: string) {
  const defaultBranch = repo.tip() === undefined ? repo.defaultBranch : repo.defaultBranch;
  return {
    id: repo.id,
    node_id: encodeNodeId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.privateRepo,
    owner: userJson(repo.owner, origin),
    html_url: `${origin}/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${repo.fullName}`,
    clone_url: `${origin}/${repo.fullName}.git`,
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${repo.fullName}.git`,
    ssh_url: `git@${origin.replace(/^https?:\/\//, '').split(':')[0]}:${repo.fullName}.git`,
    default_branch: defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.privateRepo ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label, origin: string) {
  return {
    id: label.name.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) + 1000,
    node_id: encodeNodeId('Label', label.name),
    url: `${origin}/api/v3/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue, origin: string) {
  const base = `${origin}/api/v3/repos/${repo.fullName}`;
  return {
    id: issue.id,
    node_id: encodeNodeId('Issue', issue.id),
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `${origin}/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user, origin),
    labels: issue.labels.map((label) => labelJson(label, origin)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    author_association: 'OWNER',
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; user: User; createdAt: string; updatedAt: string }, origin: string) {
  const base = `${origin}/api/v3/repos/${repo.fullName}`;
  return {
    id: comment.id,
    node_id: encodeNodeId('IssueComment', comment.id),
    url: `${base}/issues/comments/${comment.id}`,
    html_url: `${origin}/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${base}/issues/${issueNumber}`,
    body: comment.body,
    user: userJson(comment.user, origin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Pull, origin: string) {
  const base = `${origin}/api/v3/repos/${repo.fullName}`;
  const headSha = repo.tip(pull.head) ?? pull.headSha;
  return {
    id: pull.id,
    node_id: encodeNodeId('PullRequest', pull.id),
    url: `${base}/pulls/${pull.number}`,
    html_url: `${origin}/${repo.fullName}/pull/${pull.number}`,
    diff_url: `${origin}/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `${origin}/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `${base}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(pull.user, origin),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: 'clean',
    merged_by: pull.merged ? userJson(pull.user, origin) : null,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: repo.pullDiff(pull).length,
    head: {
      label: `${repo.ownerLogin}:${pull.head}`,
      ref: pull.head,
      sha: headSha,
      user: userJson(repo.owner, origin),
      repo: repoJson(repo, origin),
    },
    base: {
      label: `${repo.ownerLogin}:${pull.base}`,
      ref: pull.base,
      sha: pull.baseSha,
      user: userJson(repo.owner, origin),
      repo: repoJson(repo, origin),
    },
    author_association: 'OWNER',
    draft: false,
  };
}

function commitJson(repo: Repo, sha: string, origin: string) {
  const data = repo.commitData(sha);
  const base = `${origin}/api/v3/repos/${repo.fullName}`;
  const author = data === undefined ? null : repo.owner;
  return {
    sha,
    node_id: encodeNodeId('Commit', sha),
    url: `${base}/commits/${sha}`,
    html_url: `${origin}/${repo.fullName}/commit/${sha}`,
    comments_url: `${base}/commits/${sha}/comments`,
    commit: {
      author: data === undefined ? null : { name: data.author.name, email: data.author.email, date: new Date(data.author.date * 1000).toISOString() },
      committer: data === undefined ? null : { name: data.committer.name, email: data.committer.email, date: new Date(data.committer.date * 1000).toISOString() },
      message: data?.message ?? '',
      tree: { sha: data?.tree ?? '', url: `${base}/git/trees/${data?.tree ?? ''}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: author === null ? null : userJson(author, origin),
    committer: author === null ? null : userJson(author, origin),
    parents: (data?.parents ?? []).map((parent) => ({ sha: parent, url: `${base}/commits/${parent}` })),
  };
}

function refJson(repo: Repo, ref: string, sha: string, origin: string) {
  return {
    ref,
    node_id: encodeNodeId('Ref', ref),
    url: `${origin}/api/v3/repos/${repo.fullName}/git/${ref}`,
    object: { type: 'commit', sha, url: `${origin}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
  };
}

function contentFileJson(repo: Repo, path: string, blobSha: string, origin: string) {
  const object = repo.object(blobSha);
  const data = object?.data ?? Buffer.alloc(0);
  const base = `${origin}/api/v3/repos/${repo.fullName}`;
  const name = path.split('/').pop() ?? path;
  return {
    name,
    path,
    sha: blobSha,
    size: data.length,
    url: `${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    html_url: `${origin}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${base}/git/blobs/${blobSha}`,
    download_url: `${origin}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
    type: 'file',
    content: encodeBase64(data),
    encoding: 'base64',
    _links: { self: `${base}/contents/${path}`, git: `${base}/git/blobs/${blobSha}`, html: `${origin}/${repo.fullName}/blob/${repo.defaultBranch}/${path}` },
  };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function handleRest(forge: Forge, method: string, url: URL, body: Buffer, origin: string, authorization: string | null): RestAnswer | null {
  const pathname = url.pathname;
  if (!isRestPath(pathname)) return null;

  const bearer = authorization !== null && /^Bearer\s+\S+/i.test(authorization.trim());
  const segments = pathname.replace(/^\/api\/v3\/?/, '').split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  let payload: Record<string, unknown> = {};
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      return message(400, 'Problems parsing JSON');
    }
  }

  if (!bearer) return message(401, 'Requires authentication');

  const viewer = forge.viewer;
  const query = url.searchParams;

  if (segments.length === 0) {
    return answer(200, {
      current_user_url: `${origin}/api/v3/user`,
      current_user_authorizations_html_url: `${origin}/settings/connections/applications`,
      authorizations_url: `${origin}/api/v3/authorizations`,
      code_search_url: `${origin}/api/v3/search/code?q={query}`,
      commit_search_url: `${origin}/api/v3/search/commits?q={query}`,
      emails_url: `${origin}/api/v3/user/emails`,
      emojis_url: `${origin}/api/v3/emojis`,
      events_url: `${origin}/api/v3/events`,
      feeds_url: `${origin}/api/v3/feeds`,
      followers_url: `${origin}/api/v3/user/followers`,
      following_url: `${origin}/api/v3/user/following{/other_user}`,
      gists_url: `${origin}/api/v3/gists{/gist_id}`,
      hub_url: `${origin}/api/v3/hub`,
      issue_search_url: `${origin}/api/v3/search/issues?q={query}`,
      issues_url: `${origin}/api/v3/issues`,
      keys_url: `${origin}/api/v3/user/keys`,
      label_search_url: `${origin}/api/v3/search/labels?q={query}`,
      notifications_url: `${origin}/api/v3/notifications`,
      organization_url: `${origin}/api/v3/orgs/{org}`,
      organization_repositories_url: `${origin}/api/v3/orgs/{org}/repos`,
      organization_teams_url: `${origin}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${origin}/api/v3/gists/public`,
      rate_limit_url: `${origin}/api/v3/rate_limit`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${origin}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${origin}/api/v3/user/repos`,
      starred_url: `${origin}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${origin}/api/v3/gists/starred`,
      team_url: `${origin}/api/v3/teams`,
      user_url: `${origin}/api/v3/users/{user}`,
      user_organizations_url: `${origin}/api/v3/user/orgs`,
      user_repositories_url: `${origin}/api/v3/users/{user}/repos`,
      user_search_url: `${origin}/api/v3/search/users?q={query}`,
    }, { 'x-oauth-scopes': 'repo, read:org', 'x-github-media-type': 'github.v3' });
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return answer(200, { installed_version: '3.0.0', verifiable_password_authentication: false, ssh_key_fingerprints: {}, hooks: [], web: [], api: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [], dom0: [] });
  }

  if (segments[0] === 'rate_limit' && method === 'GET') {
    return answer(200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1767225600, used: 1 }, search: { limit: 30, remaining: 30, reset: 1767225600, used: 0 } }, rate: { limit: 5000, remaining: 4999, reset: 1767225600, used: 1 } });
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return answer(200, userJson(viewer, origin));
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2 && method === 'GET') {
    return listUserRepos(forge, viewer, url, origin);
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2 && method === 'POST') {
    const name = typeof payload.name === 'string' ? payload.name : '';
    const description = typeof payload.description === 'string' ? payload.description : null;
    const isPrivate = payload.private === true;
    const created = forge.createRepo(viewer, name, description, isPrivate);
    if (created.repo === undefined) return message(422, created.error ?? 'Repository creation failed', {});
    return answer(201, repoJson(created.repo, origin));
  }

  if (segments[0] === 'users' && segments.length === 2 && method === 'GET') {
    const user = forge.user(segments[1] as string);
    if (user === undefined) return message(404, 'Not Found');
    return answer(200, userJson(user, origin));
  }

  if (segments[0] === 'users' && segments[2] === 'repos' && segments.length === 3 && method === 'GET') {
    const user = forge.user(segments[1] as string);
    if (user === undefined) return message(404, 'Not Found');
    return listUserRepos(forge, user, url, origin);
  }

  if (segments[0] === 'orgs' && segments.length >= 2) {
    const org = segments[1] as string;
    if (org !== forge.org) return message(404, 'Not Found');
    if (segments.length === 2 && method === 'GET') {
      return answer(200, { login: forge.org, id: forge.orgId, node_id: encodeNodeId('Organization', forge.orgId), url: `${origin}/api/v3/orgs/${forge.org}`, html_url: `${origin}/${forge.org}`, description: 'the scenario organization', type: 'Organization', repositories_url: `${origin}/api/v3/orgs/${forge.org}/repos` });
    }
    if (segments[2] === 'repos' && segments.length === 3 && method === 'GET') {
      return answer(200, forge.listRepos(forge.org).map((repo) => repoJson(repo, origin)));
    }
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    if (segments[0] === 'repositories' && segments.length >= 2 && method === 'GET') {
      const id = Number(segments[1]);
      const repo = [...forge.repos.values()].find((candidate) => candidate.id === id);
      if (repo === undefined) return message(404, 'Not Found');
      return answer(200, repoJson(repo, origin));
    }
    return NOT_FOUND;
  }

  const ownerLogin = segments[1] as string;
  const repoName = segments[2] as string;
  if (ownerLogin !== viewer.login) return message(404, 'Not Found');
  const repo = forge.repo(ownerLogin, repoName);
  if (repo === undefined) return message(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return answer(200, repoJson(repo, origin));
    if (method === 'PATCH') {
      if (typeof payload.description === 'string') repo.description = payload.description;
      if (typeof payload.private === 'boolean') repo.privateRepo = payload.private;
      if (typeof payload.default_branch === 'string' && payload.default_branch !== '') repo.defaultBranch = payload.default_branch;
      repo.updatedAt = new Date().toISOString();
      return answer(200, repoJson(repo, origin));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(ownerLogin, repoName);
      return { status: 204, headers: {}, body: undefined };
    }
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length));
      return answer(200, names.map((name) => {
        const sha = repo.ref(`refs/heads/${name}`) ?? '';
        return { name, commit: { sha, url: `${origin}/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } }, protection_url: `${origin}/api/v3/repos/${repo.fullName}/branches/${name}/protection` };
      }));
    }
    if (rest.length === 2 && method === 'GET') {
      const name = rest[1] as string;
      const sha = repo.tip(name);
      if (sha === undefined) return message(404, 'Branch not found');
      return answer(200, { name, commit: { sha, commit: commitJson(repo, sha, origin).commit }, _links: { self: `${origin}/api/v3/repos/${repo.fullName}/branches/${name}`, html: `${origin}/${repo.fullName}/tree/${name}` }, protected: false });
    }
  }

  if (rest[0] === 'commits' && method === 'GET') {
    if (rest.length === 1) {
      const rev = query.get('sha') ?? undefined;
      const tip = repo.resolve(rev);
      if (tip === undefined) return message(404, 'Not Found');
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
      const commits = repo.history(tip, perPage);
      return answer(200, commits.map((sha) => commitJson(repo, sha, origin)));
    }
    if (rest.length === 2) {
      const sha = repo.resolve(rest[1] as string);
      if (sha === undefined) return message(404, 'Not Found');
      return answer(200, commitJson(repo, sha, origin));
    }
  }

  if (rest[0] === 'contents') {
    const rawPath = rest.slice(1).join('/');
    return handleContents(forge, repo, viewer, method, rawPath, payload, origin);
  }

  if (rest[0] === 'git') return handleGitData(forge, repo, method, rest.slice(1), payload, origin, query);

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') return answer(200, [...repo.labels.values()].map((label) => labelJson(label, origin)));
    if (rest.length === 1 && method === 'POST') {
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (name === '') return message(422, 'Validation Failed');
      const label: Label = { name, color: typeof payload.color === 'string' ? payload.color.replace(/^#/, '') : 'ededed', description: typeof payload.description === 'string' ? payload.description : null };
      repo.labels.set(name, label);
      return answer(201, labelJson(label, origin));
    }
    if (rest.length === 2 && method === 'GET') {
      const label = repo.labels.get(rest[1] as string);
      if (label === undefined) return message(404, 'Not Found');
      return answer(200, labelJson(label, origin));
    }
  }

  if (rest[0] === 'collaborators') {
    if (rest.length === 1 && method === 'GET') return answer(200, [userJson(viewer, origin)]);
    if (rest.length === 2) {
      if (method === 'PUT') return { status: 201, headers: {}, body: undefined };
      if (method === 'DELETE') return { status: 204, headers: {}, body: undefined };
      if (method === 'GET') {
        const user = forge.user(rest[1] as string);
        if (user === undefined) return message(404, 'Not Found');
        return answer(200, userJson(user, origin));
      }
    }
  }

  if (rest[0] === 'issues') return handleIssues(forge, repo, viewer, method, rest.slice(1), payload, origin, query);

  if (rest[0] === 'pulls') return handlePulls(forge, repo, viewer, method, rest.slice(1), payload, origin, query);

  return NOT_FOUND;
}

function listUserRepos(forge: Forge, user: User, url: URL, origin: string): RestAnswer {
  const repos = forge.listRepos(user.login);
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const path = url.pathname;
  if (start + perPage < repos.length) {
    const next = new URL(`${origin}${path}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    links.push(`<${next.toString()}>; rel="next"`);
    const last = new URL(`${origin}${path}`);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(Math.max(1, Math.ceil(repos.length / perPage))));
    links.push(`<${last.toString()}>; rel="last"`);
  }
  if (page > 1) {
    const prev = new URL(`${origin}${path}`);
    prev.searchParams.set('per_page', String(perPage));
    prev.searchParams.set('page', String(page - 1));
    links.push(`<${prev.toString()}>; rel="prev"`);
  }
  if (links.length > 0) headers.link = links.join(', ');
  return answer(200, slice.map((repo) => repoJson(repo, origin)), headers);
}

function handleContents(forge: Forge, repo: Repo, viewer: User, method: string, rawPath: string, payload: Record<string, unknown>, origin: string): RestAnswer {
  const ref = typeof payload.ref === 'string' ? payload.ref : typeof payload.branch === 'string' ? payload.branch : undefined;
  const refFromQueryRef: string | undefined = ref;
  const treeShaOf = (rev?: string): string | undefined => {
    const sha = repo.resolve(rev);
    return sha === undefined ? undefined : repo.commitData(sha)?.tree;
  };
  const branch = typeof payload.branch === 'string' ? payload.branch : undefined;
  const targetBranch = branch ?? repo.defaultBranch;
  const path = rawPath.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const tip = repo.resolve(typeof refFromQueryRef === 'string' ? refFromQueryRef : targetBranch);
    if (tip === undefined) return message(404, 'Not Found');
    const tree = repo.commitData(tip)?.tree;
    const found = path === '' ? { type: 'tree' as const, sha: tree ?? '' } : repo.treeAt(tree, path);
    if (found === undefined) return message(404, 'Not Found');
    if (found.type === 'blob') return answer(200, contentFileJson(repo, path, found.sha, origin));
    const entries = repo.treeEntries(found.sha) ?? [];
    return answer(200, entries.map((entry) => {
      const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const directory = entry.mode === '40000' || entry.mode === '040000';
      const size = directory ? 0 : (repo.object(entry.sha)?.data.length ?? 0);
      return {
        name: entry.name,
        path: entryPath,
        sha: entry.sha,
        size,
        url: `${origin}/api/v3/repos/${repo.fullName}/contents/${encodePath(entryPath)}`,
        html_url: `${origin}/${repo.fullName}/${directory ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
        git_url: `${origin}/api/v3/repos/${repo.fullName}/git/${directory ? 'trees' : 'blobs'}/${entry.sha}`,
        download_url: directory ? null : `${origin}/${repo.fullName}/raw/${repo.defaultBranch}/${entryPath}`,
        type: directory ? 'dir' : 'file',
        _links: { self: `${origin}/api/v3/repos/${repo.fullName}/contents/${encodePath(entryPath)}`, git: `${origin}/api/v3/repos/${repo.fullName}/git/${directory ? 'trees' : 'blobs'}/${entry.sha}`, html: `${origin}/${repo.fullName}/${directory ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}` },
      };
    }));
  }

  if (method === 'PUT') {
    const messageText = typeof payload.message === 'string' && payload.message !== '' ? payload.message : 'update file';
    const encoded = typeof payload.content === 'string' ? payload.content : '';
    const content = decodeBase64(encoded);
    const tip = repo.resolve(branch);
    if (tip === undefined && branch !== undefined && repo.tip(repo.defaultBranch) === undefined) {
      // an unborn repository: the first write is the root commit, even when it names a branch
    }
    const rootTree = tip === undefined ? undefined : repo.commitData(tip)?.tree;
    const existing = path === '' ? undefined : repo.treeAt(rootTree, path);
    if (existing !== undefined && existing.type !== 'blob') return message(422, 'path is a directory');
    const oldSha = typeof payload.sha === 'string' ? payload.sha : undefined;
    if (oldSha !== undefined) {
      if (existing === undefined) return message(409, 'sha does not match');
      if (existing.sha !== oldSha) return message(409, 'sha does not match');
    }
    const commit = repo.commitChanges(targetBranch, [{ path, content }], messageText, viewer, { createFromDefault: true });
    if (commit === null) return message(422, 'could not commit');
    const contentSha = commit.contentShas.get(path) ?? (existing?.sha ?? '');
    const status = existing === undefined ? 201 : 200;
    const data = repo.object(contentSha);
    return answer(status, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: contentSha,
        size: data?.data.length ?? content.length,
        url: `${origin}/api/v3/repos/${repo.fullName}/contents/${encodePath(path)}`,
        html_url: `${origin}/${repo.fullName}/blob/${targetBranch}/${path}`,
        git_url: `${origin}/api/v3/repos/${repo.fullName}/git/blobs/${contentSha}`,
        download_url: `${origin}/${repo.fullName}/raw/${targetBranch}/${path}`,
        type: 'file',
        content: encodeBase64(data?.data ?? content),
        encoding: 'base64',
        _links: { self: `${origin}/api/v3/repos/${repo.fullName}/contents/${encodePath(path)}`, git: `${origin}/api/v3/repos/${repo.fullName}/git/blobs/${contentSha}`, html: `${origin}/${repo.fullName}/blob/${targetBranch}/${path}` },
      },
      commit: commitResponse(repo, commit.commitSha, origin),
    });
  }

  if (method === 'DELETE') {
    const tip = repo.resolve(branch);
    if (tip === undefined) return message(404, 'Not Found');
    const rootTree = repo.commitData(tip)?.tree;
    const existing = path === '' ? undefined : repo.treeAt(rootTree, path);
    if (existing === undefined || existing.type !== 'blob') return message(404, 'Not Found');
    const oldSha = typeof payload.sha === 'string' ? payload.sha : undefined;
    if (oldSha !== undefined && oldSha !== existing.sha) return message(409, 'sha does not match');
    const messageText = typeof payload.message === 'string' && payload.message !== '' ? payload.message : 'delete file';
    const commit = repo.commitChanges(targetBranch, [{ path, content: null }], messageText, viewer, { createFromDefault: false });
    if (commit === null) return message(422, 'could not commit');
    return answer(200, { content: null, commit: commitResponse(repo, commit.commitSha, origin) });
  }

  return NOT_FOUND;
}

function commitResponse(repo: Repo, sha: string, origin: string) {
  const json = commitJson(repo, sha, origin);
  return {
    sha,
    node_id: json.node_id,
    url: json.url,
    html_url: json.html_url,
    author: json.author,
    committer: json.committer,
    message: json.commit.message,
    tree: json.commit.tree,
    parents: json.parents,
    verification: json.commit.verification,
  };
}

function handleGitData(forge: Forge, repo: Repo, method: string, rest: string[], payload: Record<string, unknown>, origin: string, query: URLSearchParams): RestAnswer {
  if (rest[0] === 'refs' || rest[0] === 'matching-refs') {
    if (rest[0] === 'refs' && rest.length === 1 && method === 'GET') {
      return answer(200, [...repo.refs.entries()].map(([ref, sha]) => refJson(repo, ref, sha, origin)));
    }
    if (rest[0] === 'refs' && rest.length === 1 && method === 'POST') {
      const ref = typeof payload.ref === 'string' ? payload.ref : '';
      const sha = typeof payload.sha === 'string' ? payload.sha : '';
      if (!ref.startsWith('refs/')) return message(422, 'ref must start with refs/');
      if (repo.object(sha) === undefined) return message(422, 'sha does not exist');
      repo.setRef(ref, sha);
      return answer(201, refJson(repo, ref, sha, origin));
    }
    if (rest[0] === 'refs' && rest.length >= 2) {
      const ref = rest.slice(1).join('/');
      if (method === 'GET') {
        const sha = repo.refs.get(ref);
        if (sha === undefined) return message(404, 'Not Found');
        return answer(200, refJson(repo, ref, sha, origin));
      }
      if (method === 'PATCH') {
        const sha = typeof payload.sha === 'string' ? payload.sha : '';
        const current = repo.refs.get(ref);
        if (current === undefined) return message(404, 'Not Found');
        if (repo.object(sha) === undefined) return message(422, 'sha does not exist');
        if (payload.force !== true && sha !== current && !repo.history(sha, 1000).includes(current)) return message(422, 'Update is not a fast forward');
        repo.setRef(ref, sha);
        return answer(200, refJson(repo, ref, sha, origin));
      }
      if (method === 'DELETE') {
        repo.deleteRef(ref);
        return { status: 204, headers: {}, body: undefined };
      }
    }
    if (rest[0] === 'matching-refs' && rest.length === 2 && method === 'GET') {
      const prefix = rest[1] as string;
      return answer(200, [...repo.refs.entries()].filter(([ref]) => ref.startsWith(prefix)).map(([ref, sha]) => refJson(repo, ref, sha, origin)));
    }
  }

  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const sha = repo.resolve(rest[1] as string);
    if (sha === undefined) return message(404, 'Not Found');
    return answer(200, commitJson(repo, sha, origin));
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'POST') {
    const messageText = typeof payload.message === 'string' ? payload.message : '';
    const treeSha = typeof payload.tree === 'string' ? payload.tree : '';
    const parents = Array.isArray(payload.parents) ? payload.parents.filter((parent): parent is string => typeof parent === 'string') : [];
    if (repo.object(treeSha) === undefined) return message(422, 'tree does not exist');
    const written = repo.writeCommit(treeSha, parents, messageText, repo.owner);
    return answer(201, commitJson(repo, written.sha, origin));
  }

  if (rest[0] === 'trees' && rest.length >= 2) {
    const sha = repo.resolve(rest[1] as string);
    if (sha === undefined) return message(404, 'Not Found');
    const object = repo.object(sha);
    if (object === undefined || object.type !== 'tree') return message(404, 'Not Found');
    const entries = repo.treeEntries(sha) ?? [];
    const recursive = query.get('recursive') !== null;
    const out: unknown[] = [];
    const walk = (entriesToWalk: typeof entries, prefix: string): void => {
      for (const entry of entriesToWalk) {
        const entryPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const directory = entry.mode === '40000' || entry.mode === '040000';
        out.push({ path: entryPath, mode: entry.mode, type: directory ? 'tree' : 'blob', sha: entry.sha, size: directory ? undefined : (repo.object(entry.sha)?.data.length ?? 0), url: `${origin}/api/v3/repos/${repo.fullName}/git/${directory ? 'trees' : 'blobs'}/${entry.sha}` });
        if (recursive && directory) walk(repo.treeEntries(entry.sha) ?? [], entryPath);
      }
    };
    walk(entries, '');
    return answer(200, { sha, url: `${origin}/api/v3/repos/${repo.fullName}/git/trees/${sha}`, tree: out, truncated: false });
  }

  if (rest[0] === 'trees' && rest.length === 1 && method === 'POST') {
    const tree = Array.isArray(payload.tree) ? payload.tree : [];
    const entries = tree
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
      .map((entry) => ({ mode: typeof entry.mode === 'string' ? entry.mode : '100644', name: typeof entry.path === 'string' ? entry.path : '', sha: typeof entry.sha === 'string' ? entry.sha : '' }))
      .filter((entry) => entry.name !== '' && !entry.name.includes('/'));
    const data = { type: 'tree' as const, data: buildTree(entries) };
    const sha = repo.offerObject(data);
    return answer(201, { sha, url: `${origin}/api/v3/repos/${repo.fullName}/git/trees/${sha}`, tree: entries.map((entry) => ({ path: entry.name, mode: entry.mode, type: entry.mode === '40000' ? 'tree' : 'blob', sha: entry.sha })), truncated: false });
  }

  if (rest[0] === 'blobs' && rest.length === 2 && method === 'GET') {
    const sha = repo.resolve(rest[1] as string);
    const object = sha === undefined ? undefined : repo.object(sha);
    if (object === undefined || object.type !== 'blob') return message(404, 'Not Found');
    return answer(200, { sha, node_id: encodeNodeId('Blob', sha), size: object.data.length, url: `${origin}/api/v3/repos/${repo.fullName}/git/blobs/${sha}`, content: encodeBase64(object.data), encoding: 'base64' });
  }

  if (rest[0] === 'blobs' && rest.length === 1 && method === 'POST') {
    const content = typeof payload.content === 'string' ? decodeBase64(payload.content) : Buffer.alloc(0);
    const sha = repo.offerObject({ type: 'blob', data: content });
    return answer(201, { sha, url: `${origin}/api/v3/repos/${repo.fullName}/git/blobs/${sha}` });
  }

  if (rest[0] === 'tags' && rest.length === 1 && method === 'GET') {
    return answer(200, []);
  }

  return NOT_FOUND;
}

// A tiny indirection so the tree POST builds through lib's own builder without another top import.

function handleIssues(forge: Forge, repo: Repo, viewer: User, method: string, rest: string[], payload: Record<string, unknown>, origin: string, query: URLSearchParams): RestAnswer {
  if (rest.length === 0 && method === 'GET') {
    return listIssues(repo, origin, query);
  }
  if (rest.length === 0 && method === 'POST') {
    const title = typeof payload.title === 'string' ? payload.title : '';
    if (title === '') return message(422, 'Validation Failed');
    const labels: Label[] = [];
    if (Array.isArray(payload.labels)) {
      for (const name of payload.labels) {
        if (typeof name !== 'string') continue;
        const label = repo.labels.get(name);
        if (label === undefined) return message(422, `Label does not exist: ${name}`);
        labels.push(label);
      }
    }
    const issue = repo.createIssue(viewer, title, typeof payload.body === 'string' ? payload.body : '', labels);
    return answer(201, issueJson(repo, issue, origin));
  }
  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.find((candidate) => candidate.number === number) : undefined;
  if (issue === undefined) return message(404, 'Not Found');
  if (rest.length === 1 && method === 'GET') return answer(200, issueJson(repo, issue, origin));
  if (rest.length === 1 && method === 'PATCH') {
    if (typeof payload.title === 'string') issue.title = payload.title;
    if (typeof payload.body === 'string') issue.body = payload.body;
    if (payload.state === 'open' || payload.state === 'closed') {
      issue.state = payload.state;
      issue.closedAt = payload.state === 'closed' ? new Date().toISOString() : null;
    }
    if (Array.isArray(payload.labels)) {
      const labels: Label[] = [];
      for (const name of payload.labels) {
        if (typeof name !== 'string') continue;
        const label = repo.labels.get(name) ?? { name, color: 'ededed', description: null };
        labels.push(label);
      }
      issue.labels = labels;
    }
    issue.updatedAt = new Date().toISOString();
    return answer(200, issueJson(repo, issue, origin));
  }
  if (rest[1] === 'comments' && (rest.length === 2 || rest.length === 3)) {
    if (method === 'GET' && rest.length === 2) return answer(200, issue.comments.map((comment) => commentJson(repo, issue.number, comment, origin)));
    if (method === 'POST' && rest.length === 2) {
      const text = typeof payload.body === 'string' ? payload.body : '';
      const now = new Date().toISOString();
      const comment = { id: repo.nextCommentId++, body: text, user: viewer, createdAt: now, updatedAt: now, issueNumber: issue.number };
      issue.comments.push(comment);
      return answer(201, commentJson(repo, issue.number, comment, origin));
    }
  }
  return NOT_FOUND;
}

function listIssues(repo: Repo, origin: string, query: URLSearchParams): RestAnswer {
  const state = (query.get('state') ?? 'open').toLowerCase();
  const sort = (query.get('sort') ?? 'created').toLowerCase();
  const direction = (query.get('direction') ?? 'desc').toLowerCase();
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const filtered = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const indexed = filtered.map((issue, index) => ({ issue, index }));
  indexed.sort((a, b) => {
    let delta = 0;
    if (sort === 'updated') delta = a.issue.updatedAt.localeCompare(b.issue.updatedAt);
    else if (sort === 'comments') delta = a.issue.comments.length - b.issue.comments.length;
    else delta = a.index - b.index;
    if (delta === 0) delta = a.issue.number - b.issue.number;
    return direction === 'asc' ? delta : -delta;
  });
  return answer(200, indexed.slice(0, perPage).map((entry) => issueJson(repo, entry.issue, origin)));
}

function handlePulls(forge: Forge, repo: Repo, viewer: User, method: string, rest: string[], payload: Record<string, unknown>, origin: string, query: URLSearchParams): RestAnswer {
  if (rest.length === 0 && method === 'GET') {
    const state = (query.get('state') ?? 'open').toLowerCase();
    const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
    const list = repo.pulls.filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open')).slice(0, perPage);
    return answer(200, list.map((pull) => pullJson(repo, pull, origin)));
  }
  if (rest.length === 0 && method === 'POST') {
    const title = typeof payload.title === 'string' ? payload.title : '';
    const headRaw = typeof payload.head === 'string' ? payload.head : '';
    const base = typeof payload.base === 'string' ? payload.base : repo.defaultBranch;
    const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
    if (title === '' || head === '') return message(422, 'Validation Failed');
    const pull = repo.createPull(viewer, title, typeof payload.body === 'string' ? payload.body : '', head, base);
    if (pull === null) return message(422, 'Validation Failed');
    return answer(201, pullJson(repo, pull, origin));
  }
  if (rest[0] === 'comments' && method === 'GET') {
    return answer(200, []);
  }
  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.find((candidate) => candidate.number === number) : undefined;
  if (pull === undefined) return message(404, 'Not Found');
  if (rest.length === 1 && method === 'GET') return answer(200, pullJson(repo, pull, origin));
  if (rest.length === 1 && method === 'PATCH') {
    if (typeof payload.title === 'string') pull.title = payload.title;
    if (typeof payload.body === 'string') pull.body = payload.body;
    if (payload.state === 'open' || payload.state === 'closed') pull.state = payload.state;
    pull.updatedAt = new Date().toISOString();
    return answer(200, pullJson(repo, pull, origin));
  }
  if (rest[1] === 'files' && method === 'GET') {
    const headTree = repo.commitData(repo.tip(pull.head) ?? pull.headSha)?.tree;
    const files = repo.pullDiff(pull).map((file) => ({
      sha: repo.treeAt(headTree, file.path)?.sha ?? '',
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      blob_url: `${origin}/${repo.fullName}/blob/${pull.head}/${file.path}`,
      raw_url: `${origin}/${repo.fullName}/raw/${pull.head}/${file.path}`,
      contents_url: `${origin}/api/v3/repos/${repo.fullName}/contents/${encodePath(file.path)}?ref=${pull.head}`,
    }));
    return answer(200, files);
  }
  if (rest[1] === 'merge' && method === 'PUT') {
    const methodName = typeof payload.merge_method === 'string' ? payload.merge_method : 'merge';
    const result = repo.mergePull(pull, methodName);
    if ('missing' in result) return message(404, 'Not Found');
    if ('conflict' in result) return message(405, 'Pull Request is not mergeable');
    return answer(200, { sha: result.sha, merged: true, message: result.message });
  }
  if (rest[1] === 'commits' && method === 'GET') {
    const commits = repo.history(pull.headSha, 100).map((sha) => commitJson(repo, sha, origin));
    return answer(200, commits);
  }
  return NOT_FOUND;
}

export { DEFAULT_BRANCH };
