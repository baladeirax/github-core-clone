// HTTP plumbing: one Node http server, a tiny router, shared auth and response
// helpers. The four surfaces (REST, GraphQL, MCP, smart HTTP) plug in as handlers.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';

export interface Context {
  readonly store: Store;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly segments: string[];
  readonly body: Buffer;
  readonly requestId: string;
  readonly host: string;
  json(status: number, value: unknown, extraHeaders?: Record<string, string>): void;
  text(status: number, body: string | Buffer, contentType: string, extraHeaders?: Record<string, string>): void;
  error(status: number, message: string): void;
  parsedBody<T = unknown>(): T | null;
}

export type Handler = (ctx: Context) => Promise<boolean>;

const MAX_BODY = 16 * 1024 * 1024;

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  const token = match[1].trim();
  return token === '' ? null : token;
}

export function createForgeServer(store: Store, handlers: readonly Handler[]) {
  let counter = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const requestId = `req-${++counter}`;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_BODY) {
            tooLarge = true;
            break;
          }
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks);
        if (tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId });
          res.end(JSON.stringify({ message: 'request body too large' }));
          return;
        }
        const host = req.headers.host ?? '127.0.0.1';
        const url = new URL(req.url ?? '/', `http://${host}`);
        const path = decodeURIComponent(url.pathname);
        const segments = path.split('/').filter((part) => part !== '');
        const ctx: Context = {
          store,
          req,
          res,
          method: req.method ?? 'GET',
          url,
          path,
          segments,
          body,
          requestId,
          host,
          json(status, value, extraHeaders) {
            const payload = typeof value === 'string' ? value : JSON.stringify(value);
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'X-GitHub-Request-Id': requestId,
              ...(extraHeaders ?? {}),
            };
            res.writeHead(status, headers);
            res.end(payload);
          },
          text(status, bodyText, contentType, extraHeaders) {
            const payload = typeof bodyText === 'string' ? Buffer.from(bodyText, 'utf8') : bodyText;
            const headers: Record<string, string> = {
              'Content-Type': contentType,
              'X-GitHub-Request-Id': requestId,
              ...(extraHeaders ?? {}),
            };
            res.writeHead(status, headers);
            res.end(payload);
          },
          error(status, message) {
            this.json(status, { message });
          },
          parsedBody<T = unknown>(): T | null {
            if (body.length === 0) return null;
            try {
              return JSON.parse(body.toString('utf8')) as T;
            } catch {
              return null;
            }
          },
        };
        for (const handler of handlers) {
          if (await handler(ctx)) return;
        }
        ctx.error(404, 'Not Found');
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId });
          res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'internal error' }));
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}

/** Parse a query param as a positive integer, with a default. */
export function queryInt(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Parse a Link-header page request (page, per_page) from the query string. */
export function pagination(url: URL): { page: number; perPage: number } {
  return { page: queryInt(url, 'page', 1), perPage: queryInt(url, 'per_page', 30) };
}

/** The standard RFC 5988 Link header for paginated lists (absolute URLs). */
export function linkHeader(ctx: Context, page: number, perPage: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const base = `${ctx.url.pathname}?per_page=${perPage}`;
  return { Link: `<${absoluteUrl(ctx, `${base}&page=${page + 1}`)}>; rel="next"` };
}

export function absoluteUrl(ctx: Context, pathAndQuery: string): string {
  return `http://${ctx.host}${pathAndQuery}`;
}
