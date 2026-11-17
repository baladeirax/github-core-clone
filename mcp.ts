// MCP (/mcp): JSON-RPC 2.0 Streamable HTTP, modern revision 2026-07-28 preferred,
// with the legacy initialize handshake also accepted. Six tools over the same
// store as REST. Tool results carry both a text JSON payload and structuredContent.

import { bearerToken, type Context, type Handler } from './app.ts';
import { VIEWER_LOGIN } from './store.ts';

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  handler: (ctx: Context, args: Record<string, unknown>) => { ok: boolean; data: unknown; error?: string };
}

function repoJsonFor(ctx: Context, owner: string, name: string): unknown {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return null;
  return JSON.parse(ctx.store.repoJson(repo));
}

function buildTools(): McpTool[] {
  const tools: McpTool[] = [
    {
      name: 'create_repo',
      description: 'Create a new repository for the viewer.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The repository name.' },
          description: { type: 'string', description: 'A short description of the repository.' },
          private: { type: 'boolean', description: 'Whether the repository is private.' },
        },
        required: ['name'],
      },
      handler: (ctx, args) => {
        const name = args.name;
        if (typeof name !== 'string' || name === '') return { ok: false, data: null, error: 'name is required' };
        if (ctx.store.getRepo(VIEWER_LOGIN, name)) return { ok: false, data: null, error: 'Repository already exists' };
        const repo = ctx.store.createRepo(VIEWER_LOGIN, name, {
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === true,
        });
        return { ok: true, data: JSON.parse(ctx.store.repoJson(repo)) };
      },
    },
    {
      name: 'get_repo',
      description: 'Get a repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
        },
        required: ['owner', 'repo'],
      },
      handler: (ctx, args) => {
        const owner = args.owner;
        const repoName = args.repo;
        if (typeof owner !== 'string' || typeof repoName !== 'string') {
          return { ok: false, data: null, error: 'owner and repo are required' };
        }
        const data = repoJsonFor(ctx, owner, repoName);
        if (!data) return { ok: false, data: null, error: 'Repository not found' };
        return { ok: true, data };
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
        },
        required: ['owner', 'repo', 'title'],
      },
      handler: (ctx, args) => {
        const owner = args.owner;
        const repoName = args.repo;
        const title = args.title;
        if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof title !== 'string' || title === '') {
          return { ok: false, data: null, error: 'owner, repo and title are required' };
        }
        const repo = ctx.store.getRepo(owner, repoName);
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        const issue = ctx.store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
        return { ok: true, data: JSON.parse(ctx.store.issueJson(repo, issue)) };
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
        },
        required: ['owner', 'repo'],
      },
      handler: (ctx, args) => {
        const owner = args.owner;
        const repoName = args.repo;
        if (typeof owner !== 'string' || typeof repoName !== 'string') {
          return { ok: false, data: null, error: 'owner and repo are required' };
        }
        const repo = ctx.store.getRepo(owner, repoName);
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        const state = typeof args.state === 'string' ? args.state : 'open';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => a.createdSeq - b.createdSeq);
        return { ok: true, data: issues.map((issue) => JSON.parse(ctx.store.issueJson(repo, issue))) };
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          title: { type: 'string', description: 'The pull request title.' },
          head: { type: 'string', description: 'The head branch name.' },
          base: { type: 'string', description: 'The base branch name.' },
          body: { type: 'string', description: 'The pull request body.' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
      handler: (ctx, args) => {
        const owner = args.owner;
        const repoName = args.repo;
        const title = args.title;
        const head = args.head;
        const base = args.base;
        if (
          typeof owner !== 'string' ||
          typeof repoName !== 'string' ||
          typeof title !== 'string' ||
          typeof head !== 'string' ||
          typeof base !== 'string'
        ) {
          return { ok: false, data: null, error: 'owner, repo, title, head and base are required' };
        }
        const repo = ctx.store.getRepo(owner, repoName);
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        const headTip = ctx.store.refCommit(repo, `refs/heads/${head}`);
        const baseTip = ctx.store.refCommit(repo, `refs/heads/${base}`);
        if (!headTip || !baseTip) return { ok: false, data: null, error: 'head or base branch does not exist' };
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.head === head && existing.base === base) {
            return { ok: false, data: null, error: 'A pull request already exists for this head and base' };
          }
        }
        const pull = ctx.store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
        pull.headSha = headTip;
        pull.baseSha = baseTip;
        return { ok: true, data: JSON.parse(ctx.store.pullJson(repo, pull)) };
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          pull_number: { type: 'number', description: 'The pull request number.' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      handler: (ctx, args) => {
        const owner = args.owner;
        const repoName = args.repo;
        const pullNumber = args.pull_number;
        if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof pullNumber !== 'number') {
          return { ok: false, data: null, error: 'owner, repo and pull_number are required' };
        }
        const repo = ctx.store.getRepo(owner, repoName);
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        const pull = repo.pulls.get(pullNumber);
        if (!pull) return { ok: false, data: null, error: 'Pull request not found' };
        if (pull.state !== 'open') return { ok: false, data: null, error: 'Pull request is already closed' };
        const headTip = ctx.store.refCommit(repo, `refs/heads/${pull.head}`);
        const baseTip = ctx.store.refCommit(repo, `refs/heads/${pull.base}`);
        if (!headTip || !baseTip) return { ok: false, data: null, error: 'head or base branch does not exist' };
        if (ctx.store.mergeConflicts(repo, baseTip, headTip)) {
          return { ok: false, data: null, error: 'This pull request cannot be merged due to merge conflicts' };
        }
        const mergeSha = ctx.store.squashMerge(repo, pull);
        if (!mergeSha) return { ok: false, data: null, error: 'This pull request cannot be merged' };
        return { ok: true, data: { sha: mergeSha, merged: true, message: 'Pull request successfully merged' } };
      },
    },
  ];
  return tools;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const mcpHandler: Handler = async (ctx) => {
  if (ctx.path !== '/mcp') return false;
  if (ctx.method !== 'POST') {
    ctx.error(405, 'Method Not Allowed');
    return true;
  }
  if (!bearerToken(ctx.req)) {
    ctx.json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } });
    return true;
  }
  let request: unknown;
  try {
    request = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    ctx.json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const tools = buildTools();
  // tools/list must be byte-identical across calls: build it once per request
  // from a fixed definition, so serialization is deterministic.
  const toolsList = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  const respond = (id: unknown, result: unknown): void => {
    ctx.json(200, { jsonrpc: '2.0', id, result });
  };
  const respondError = (id: unknown, code: number, message: string): void => {
    ctx.json(200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    ctx.json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const rpc = request as { method?: unknown; id?: unknown; params?: unknown };
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const id = 'id' in rpc ? rpc.id : null;
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    respond(id, {
      supportedVersions: PROTOCOL_VERSIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    respond(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return true;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id: answer with an empty 202.
    ctx.res.writeHead(202, { 'X-GitHub-Request-Id': ctx.requestId });
    ctx.res.end();
    return true;
  }
  if (method === 'ping') {
    respond(id, {});
    return true;
  }
  if (method === 'tools/list') {
    respond(id, { tools: toolsList });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      respondError(id, -32601, `Unknown tool: ${toolName}`);
      return true;
    }
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        respond(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: `Missing required argument: ${required}` }) }],
          isError: true,
        });
        return true;
      }
    }
    const outcome = tool.handler(ctx, args);
    if (!outcome.ok) {
      respond(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: outcome.error ?? 'Tool call failed' }) }],
        isError: true,
      });
      return true;
    }
    respond(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.data) }],
      structuredContent: outcome.data,
    });
    return true;
  }
  respondError(id, -32601, `Method not found: ${method}`);
  return true;
};
