// REST v3 (/api/v3): repos, branches, commits, contents, labels, issues,
// comments and pull requests, all over the shared store. Every reply carries
// X-GitHub-Request-Id; no token -> 401; a foreign owner -> 404, never 403.

import { absoluteUrl, bearerToken, linkHeader, pagination, type Context, type Handler } from './app.ts';
import { parseCommit, parseTree, ZERO_OID } from './gitobj.ts';
import { isoAt, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Issue, type Pull, type Repo } from './store.ts';

interface CreateRepoBody {
  name?: string;
  private?: boolean;
  description?: string;
}

interface ContentsBody {
  message?: string;
  content?: string;
  branch?: string;
  sha?: string;
}

function notFound(ctx: Context): void {
  ctx.error(404, 'Not Found');
}

function requireAuth(ctx: Context): boolean {
  if (!bearerToken(ctx.req)) {
    ctx.error(401, 'Requires authentication');
    return false;
  }
  return true;
}

/** The repo at /repos/{owner}/{name}, or null after answering 404. */
function repoAt(ctx: Context, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    notFound(ctx);
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    notFound(ctx);
    return null;
  }
  return repo;
}

function branchTip(ctx: Context, repo: Repo, branch: string): string | null {
  return ctx.store.refCommit(repo, `refs/heads/${branch}`);
}

function branchFiles(ctx: Context, repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = branchTip(ctx, repo, branch);
  if (!tip) return new Map();
  const commit = repo.objects.get(tip);
  if (!commit) return new Map();
  return ctx.store.treeFiles(repo, parseCommit(commit.data).tree);
}

function commitOnBranch(ctx: Context, repo: Repo, branch: string, message: string, files: Map<string, { oid: string; mode: string }>): string {
  const tree = ctx.store.buildTreeFromFiles(repo, files);
  const tip = branchTip(ctx, repo, branch);
  return ctx.store.makeCommit(repo, {
    tree,
    parents: tip ? [tip] : [],
    message,
    branch,
  });
}

function findPath(
  repo: Repo,
  treeOid: string,
  segments: string[],
): { type: 'file' | 'dir'; oid: string; mode: string; treeOid?: string } | null {
  let currentTree = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(currentTree);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((item) => item.name === segments[i]);
    if (!entry) return null;
    const last = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) return { type: 'dir', oid: entry.oid, mode: entry.mode, treeOid: entry.oid };
      currentTree = entry.oid;
    } else if (last) {
      return { type: 'file', oid: entry.oid, mode: entry.mode };
    } else {
      return null;
    }
  }
  return { type: 'dir', oid: currentTree, mode: '40000', treeOid: currentTree };
}

function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

function blobText(repo: Repo, oid: string | null): string {
  if (!oid) return '';
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

export const restHandler: Handler = async (ctx) => {
  const seg = ctx.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const rest = seg.slice(2);
  const { method } = ctx;

  // Root and meta are public, exactly like the starter.
  if (method === 'GET' && rest.length === 0) {
    ctx.json(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    ctx.json(200, { installed_version: '1.0.0' });
    return true;
  }
  if (!requireAuth(ctx)) return true;

  // GET /user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    ctx.json(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
    });
    return true;
  }

  // /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pagination(ctx.url);
      const all = ctx.store.listViewerRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const hasNext = start + perPage < all.length;
      ctx.json(200, JSON.parse(`[${slice.map((repo) => ctx.store.repoJson(repo)).join(',')}]`), linkHeader(ctx, page, perPage, hasNext));
      return true;
    }
    if (method === 'POST') {
      const body = ctx.parsedBody<CreateRepoBody>();
      if (body === null || typeof body.name !== 'string' || body.name === '') {
        ctx.error(400, 'name is required');
        return true;
      }
      if (ctx.store.getRepo(VIEWER_LOGIN, body.name)) {
        ctx.error(422, 'Repository creation failed. name already exists on this account');
        return true;
      }
      const repo = ctx.store.createRepo(VIEWER_LOGIN, body.name, {
        private: body.private === true,
        description: typeof body.description === 'string' ? body.description : '',
      });
      ctx.res.writeHead(201, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': ctx.requestId });
      ctx.res.end(ctx.store.repoJson(repo));
      return true;
    }
    return false;
  }

  // /repos/{owner}/{name}...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const tail = rest.slice(3);

    // GET /repos/{o}/{r} ; PATCH ; DELETE
    if (tail.length === 0) {
      if (method === 'GET') {
        const repo = repoAt(ctx, owner, name);
        if (!repo) return true;
        ctx.json(200, ctx.store.repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const repo = repoAt(ctx, owner, name);
        if (!repo) return true;
        const body = ctx.parsedBody<{ description?: string }>();
        if (body === null) {
          ctx.error(400, 'Invalid JSON');
          return true;
        }
        if (typeof body.description === 'string') repo.description = body.description;
        ctx.store.touchRepo(repo);
        ctx.json(200, ctx.store.repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        const repo = repoAt(ctx, owner, name);
        if (!repo) return true;
        ctx.store.deleteRepo(owner, name);
        ctx.res.writeHead(204, { 'X-GitHub-Request-Id': ctx.requestId });
        ctx.res.end();
        return true;
      }
      return false;
    }

    const repo = repoAt(ctx, owner, name);
    if (!repo) return true;

    // GET /branches ; GET /branches/{branch}
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '' } }));
        ctx.json(200, branches);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const branch = tail[1];
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) {
          notFound(ctx);
          return true;
        }
        ctx.json(200, { name: branch, commit: { sha: ctx.store.refCommit(repo, `refs/heads/${branch}`) ?? oid } });
        return true;
      }
      return false;
    }

    // GET /commits[?sha=]
    if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) {
      const ref = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = ctx.store.resolveRef(repo, ref);
      if (!tip) {
        notFound(ctx);
        return true;
      }
      const commits: { sha: string; commit: { message: string } }[] = [];
      const seen = new Set<string>();
      const queue: string[] = [tip];
      while (queue.length) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const parsed = parseCommit(object.data);
        commits.push({ sha: oid, commit: { message: parsed.message.replace(/\n+$/, '') } });
        queue.push(...parsed.parents);
      }
      // Newest first: walk order is BFS from the tip, which is newest-first for
      // linear history; sort by generation via the queue order is already fine.
      ctx.json(200, commits);
      return true;
    }

    // POST /git/refs ; GET /git/refs/heads/{branch}
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const body = ctx.parsedBody<{ ref?: string; sha?: string }>();
        if (body === null || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
          ctx.error(400, 'ref and sha are required');
          return true;
        }
        if (!body.ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(body.sha)) {
          ctx.error(422, 'Invalid ref or sha');
          return true;
        }
        if (repo.refs.has(body.ref)) {
          ctx.error(422, 'Reference already exists');
          return true;
        }
        if (!repo.objects.has(body.sha)) {
          ctx.error(422, 'Object does not exist');
          return true;
        }
        repo.refs.set(body.ref, body.sha);
        ctx.store.touchRepo(repo);
        ctx.json(201, { ref: body.ref, object: { sha: body.sha } });
        return true;
      }
      if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
        const oid = repo.refs.get(`refs/heads/${tail[3]}`);
        if (!oid) {
          notFound(ctx);
          return true;
        }
        ctx.json(200, { ref: `refs/heads/${tail[3]}`, object: { sha: oid } });
        return true;
      }
      return false;
    }

    // /contents/{path...}
    if (tail[0] === 'contents') {
      const pathSegments = tail.slice(1);
      const path = pathSegments.join('/');
      const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = ctx.store.resolveRef(repo, ref);
        if (!tip) {
          notFound(ctx);
          return true;
        }
        const commit = repo.objects.get(tip);
        if (!commit) {
          notFound(ctx);
          return true;
        }
        const treeOid = parseCommit(commit.data).tree;
        if (path === '') {
          const entries = parseTree(repo.objects.get(treeOid)!.data).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: entry.name,
            sha: entry.oid,
          }));
          ctx.json(200, entries);
          return true;
        }
        const found = findPath(repo, treeOid, pathSegments);
        if (!found) {
          notFound(ctx);
          return true;
        }
        if (found.type === 'dir') {
          const entries = parseTree(repo.objects.get(found.treeOid!)!.data).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: `${path}/${entry.name}`,
            sha: entry.oid,
          }));
          ctx.json(200, entries);
          return true;
        }
        const blob = repo.objects.get(found.oid);
        if (!blob) {
          notFound(ctx);
          return true;
        }
        ctx.json(200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: found.oid,
          size: blob.data.length,
          name: pathSegments[pathSegments.length - 1],
          path,
        });
        return true;
      }
      if (method === 'PUT') {
        const body = ctx.parsedBody<ContentsBody>();
        if (body === null || typeof body.content !== 'string' || typeof body.message !== 'string') {
          ctx.error(400, 'message and content are required');
          return true;
        }
        const branch = body.branch ?? repo.defaultBranch;
        const files = branchFiles(ctx, repo, branch);
        const existing = files.get(path);
        if (body.sha) {
          if (!existing || existing.oid !== body.sha) {
            ctx.error(409, 'sha does not match the current file');
            return true;
          }
        } else if (existing) {
          ctx.error(409, 'file already exists');
          return true;
        }
        const blobOid = ctx.store.putObject(repo, 'blob', Buffer.from(body.content, 'base64'));
        files.set(path, { oid: blobOid, mode: '100644' });
        const commitSha = commitOnBranch(ctx, repo, branch, body.message, files);
        const created = !body.sha;
        ctx.json(created ? 201 : 200, {
          content: { sha: blobOid, encoding: 'base64', name: pathSegments[pathSegments.length - 1], path },
          commit: { sha: commitSha },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = ctx.parsedBody<ContentsBody>();
        if (body === null || typeof body.sha !== 'string' || typeof body.message !== 'string') {
          ctx.error(400, 'message and sha are required');
          return true;
        }
        const branch = body.branch ?? repo.defaultBranch;
        const files = branchFiles(ctx, repo, branch);
        const existing = files.get(path);
        if (!existing) {
          notFound(ctx);
          return true;
        }
        if (existing.oid !== body.sha) {
          ctx.error(409, 'sha does not match the current file');
          return true;
        }
        files.delete(path);
        const commitSha = commitOnBranch(ctx, repo, branch, body.message, files);
        ctx.json(200, { commit: { sha: commitSha } });
        return true;
      }
      return false;
    }

    // POST /labels
    if (tail[0] === 'labels' && method === 'POST' && tail.length === 1) {
      const body = ctx.parsedBody<{ name?: string; color?: string }>();
      if (body === null || typeof body.name !== 'string' || body.name === '') {
        ctx.error(400, 'name is required');
        return true;
      }
      const existing = repo.labels.get(body.name);
      if (existing) {
        ctx.json(200, { name: existing.name, color: existing.color });
        return true;
      }
      const label = { name: body.name, color: typeof body.color === 'string' ? body.color : 'ededed' };
      repo.labels.set(label.name, label);
      ctx.json(201, label);
      return true;
    }

    // /issues...
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = ctx.parsedBody<{ title?: string; body?: string; labels?: string[] }>();
          if (body === null || typeof body.title !== 'string' || body.title === '') {
            ctx.error(400, 'title is required');
            return true;
          }
          const labels = Array.isArray(body.labels) ? body.labels : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              ctx.error(422, `Label "${label}" does not exist`);
              return true;
            }
          }
          const issue = ctx.store.createIssue(repo, body.title, body.body ?? '', labels);
          ctx.res.writeHead(201, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': ctx.requestId });
          ctx.res.end(ctx.store.issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = ctx.url.searchParams.get('state') ?? 'open';
          const sort = ctx.url.searchParams.get('sort') ?? 'created';
          const direction = ctx.url.searchParams.get('direction') ?? 'asc';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'desc' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
          }
          const { page, perPage } = pagination(ctx.url);
          const start = (page - 1) * perPage;
          const slice = issues.slice(start, start + perPage);
          const hasNext = start + perPage < issues.length;
          ctx.json(
            200,
            JSON.parse(`[${slice.map((issue) => ctx.store.issueJson(repo, issue)).join(',')}]`),
            linkHeader(ctx, page, perPage, hasNext),
          );
          return true;
        }
        return false;
      }
      const issueNumber = Number.parseInt(tail[1], 10);
      if (!Number.isInteger(issueNumber)) return false;
      const issue: Issue | undefined = repo.issues.get(issueNumber);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!issue) {
            notFound(ctx);
            return true;
          }
          ctx.json(200, ctx.store.issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (!issue) {
            notFound(ctx);
            return true;
          }
          const body = ctx.parsedBody<{ state?: string; title?: string; body?: string }>();
          if (body === null) {
            ctx.error(400, 'Invalid JSON');
            return true;
          }
          if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          ctx.store.invalidateIssue(issue);
          ctx.json(200, ctx.store.issueJson(repo, issue));
          return true;
        }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) {
          notFound(ctx);
          return true;
        }
        if (method === 'GET') {
          ctx.json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
          return true;
        }
        if (method === 'POST') {
          const body = ctx.parsedBody<{ body?: string }>();
          if (body === null || typeof body.body !== 'string') {
            ctx.error(400, 'body is required');
            return true;
          }
          const comment = ctx.store.addComment(repo, issue, body.body);
          ctx.json(201, { id: comment.id, body: comment.body });
          return true;
        }
        return false;
      }
      return false;
    }

    // /pulls...
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = ctx.parsedBody<{ title?: string; head?: string; base?: string; body?: string }>();
          if (
            body === null ||
            typeof body.title !== 'string' ||
            typeof body.head !== 'string' ||
            typeof body.base !== 'string'
          ) {
            ctx.error(400, 'title, head and base are required');
            return true;
          }
          const headTip = branchTip(ctx, repo, body.head);
          const baseTip = branchTip(ctx, repo, body.base);
          if (!headTip || !baseTip) {
            ctx.error(422, 'head or base branch does not exist');
            return true;
          }
          for (const existing of repo.pulls.values()) {
            if (existing.state === 'open' && existing.head === body.head && existing.base === body.base) {
              ctx.error(422, 'A pull request already exists for this head and base');
              return true;
            }
          }
          const pull = ctx.store.createPull(repo, body.title, body.body ?? '', body.head, body.base);
          pull.headSha = headTip;
          pull.baseSha = baseTip;
          ctx.json(201, JSON.parse(ctx.store.pullJson(repo, pull)));
          return true;
        }
        if (method === 'GET') {
          const state = ctx.url.searchParams.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          ctx.json(200, pulls.map((pull) => JSON.parse(ctx.store.pullJson(repo, pull))));
          return true;
        }
        return false;
      }
      const pullNumber = Number.parseInt(tail[1], 10);
      if (!Number.isInteger(pullNumber)) return false;
      const pull: Pull | undefined = repo.pulls.get(pullNumber);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!pull) {
            notFound(ctx);
            return true;
          }
          ctx.json(200, JSON.parse(ctx.store.pullJson(repo, pull)));
          return true;
        }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) {
          notFound(ctx);
          return true;
        }
        const headTip = ctx.store.refCommit(repo, `refs/heads/${pull.head}`);
        const baseTip = ctx.store.refCommit(repo, `refs/heads/${pull.base}`);
        if (!headTip || !baseTip) {
          ctx.json(200, []);
          return true;
        }
        const base = ctx.store.mergeBase(repo, baseTip, headTip);
        const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const diff = ctx.store.diffTrees(repo, baseTree, headTree);
        const files = [...diff.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([filename, change]) => {
            const counts = lineCounts(blobText(repo, change.oldOid), blobText(repo, change.newOid));
            return {
              filename,
              status: change.status,
              additions: counts.additions,
              deletions: counts.deletions,
              changes: counts.additions + counts.deletions,
            };
          });
        ctx.json(200, files);
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) {
          notFound(ctx);
          return true;
        }
        if (pull.state !== 'open') {
          ctx.error(405, 'Pull request is already closed');
          return true;
        }
        const body = ctx.parsedBody<{ merge_method?: string }>();
        if (body === null) {
          ctx.error(400, 'Invalid JSON');
          return true;
        }
        const headTip = ctx.store.refCommit(repo, `refs/heads/${pull.head}`);
        const baseTip = ctx.store.refCommit(repo, `refs/heads/${pull.base}`);
        if (!headTip || !baseTip) {
          ctx.error(404, 'head or base branch does not exist');
          return true;
        }
        if (ctx.store.mergeConflicts(repo, baseTip, headTip)) {
          ctx.error(405, 'This pull request cannot be merged due to merge conflicts');
          return true;
        }
        const mergeSha = ctx.store.squashMerge(repo, pull);
        if (!mergeSha) {
          ctx.error(405, 'This pull request cannot be merged');
          return true;
        }
        ctx.json(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      return false;
    }
  }

  return false;
};
