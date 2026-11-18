// The forge's HTTP front door: one node:http server over the in-memory Forge, routing the REST v3
// surface, GraphQL v4, the MCP endpoint, git smart HTTP and the env's boot probe, and answering
// GitHub's JSON 404 for everything else.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, isRestPath } from './rest.ts';
import { handleMcp } from './mcp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleGitHttp } from './githttp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function requestId(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    if (i === 8 || i === 12 || i === 16 || i === 20) out += '-';
    out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const pathname = url.pathname;
        const origin = `${url.protocol}//${url.host}`;
        const method = (req.method ?? 'GET').toUpperCase();

        if (pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (isRestPath(pathname)) {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const answer = handleRest(forge, method, url, body, origin, req.headers.authorization ?? null);
          if (answer === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          res.writeHead(answer.status, {
            'content-type': 'application/json; charset=utf-8',
            'x-github-request-id': requestId(),
            ...answer.headers,
          });
          res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
          return;
        }

        if (pathname === '/api/graphql' || pathname === '/graphql') {
          const body = await readBody(req);
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (req.headers.authorization === undefined || !/^Bearer\s+\S+/i.test(req.headers.authorization.trim())) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const answer = handleGraphQL(forge, body.toString('utf8'));
          sendJson(res, answer.status, answer.body, answer.headers);
          return;
        }

        if (pathname === '/mcp') {
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const answer = handleMcp(forge, body.toString('utf8'), method, req.headers.authorization ?? null);
          if (answer === null) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(answer.status, { 'content-type': answer.contentType, ...answer.headers });
          res.end(answer.body);
          return;
        }

        if (/\/info\/refs$/.test(pathname) || /\/(git-upload-pack|git-receive-pack)$/.test(pathname)) {
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const protocol = /(?:^|\s)version=2(?:\s|$)/.test(String(req.headers['git-protocol'] ?? ''));
          const answer = handleGitHttp(forge, method, url, body, protocol);
          if (answer !== null) {
            res.writeHead(answer.status, { 'content-type': answer.contentType, ...answer.headers });
            res.end(answer.body);
            return;
          }
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // the socket is already gone; nothing to answer
        }
      }
    })();
  });
}
