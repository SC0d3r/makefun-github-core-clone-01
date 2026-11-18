# github-core-clone-01: a GitHub-compatible forge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/SC0d3r/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/SC0d3r/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A self-contained forge for the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
contest: a single Node 22 process that speaks GitHub's REST v3 API, GraphQL v4, the Model Context
Protocol, and real git smart HTTP, all over one in-memory repository model. It uses only the Node
standard library - no dependencies, no network, and no git binary.

The server is split by surface: `app.ts` routes requests, `rest.ts` serves repositories, contents,
git data, issues, labels, collaborators and pull requests; `graphql.ts` parses and executes GraphQL
documents (including variables, fragments, aliases, introspection, mutations and batching);
`mcp.ts` implements `server/discover`, the legacy handshake and six repository tools; `githttp.ts`
serves protocol v0/v2 advertisements, `ls-refs`, shallow and incremental fetches, and pushes with
per-ref report-status. `store.ts` holds the forge state and real git object graph, and `lib.ts`
implements SHA-1 object framing, trees, commits, pkt-lines, packs and deltas. Every surface mutates
the same forge, so a repository created over REST can be pushed over git, read over GraphQL, and
merged through MCP.

## Run it

```sh
node --experimental-strip-types main.ts
```

Set `MAKEFUN_ENV_URL` to the trial env's origin (the contest harness does this); the process binds an
ephemeral port, registers it with the env, serves until the env reports done, then exits 0. The kit's
own local runner grades the same conformance suite.

## Surface

| Route | What it serves |
| --- | --- |
| `GET /healthz` | `{"ok":true}`, the env's boot probe |
| `/api/v3/...` | GitHub REST v3: users, orgs, repos, branches, commits, contents, git data, issues, comments, labels, collaborators, pulls, files and merges |
| `POST /api/graphql` | GitHub GraphQL v4 documents and operation batches |
| `POST /mcp` | MCP over HTTP: discover, initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: info/refs, upload-pack (v2/v0), receive-pack |
| anything else | `404 {"message":"Not Found"}` |

Authentication is bearer-token based: REST and GraphQL require `Authorization: Bearer <token>`,
MCP refuses unauthenticated tool calls, and git object transfer stays open so a real client can
clone and push. Every REST response carries an `x-github-request-id` header.

## Layout

- `main.ts` - the env lifecycle: bind, register, wait for done.
- `app.ts` - one `node:http` server and the routing table.
- `lib.ts` - git primitives: object ids, trees, commits, pkt-lines, packs and deltas.
- `store.ts` - the forge model: users, repositories, refs, objects, issues and pulls.
- `rest.ts` - the REST v3 handlers.
- `graphql.ts` - the GraphQL lexer, parser and executor.
- `mcp.ts` - the MCP endpoint and its six tools.
- `githttp.ts` - the git smart-HTTP transport.

Licensed under the MIT licence in `LICENSE`.
