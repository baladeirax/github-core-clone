// The forge's one store: repositories, git objects, refs, issues, pull requests,
// labels and comments, shared by REST, GraphQL, MCP and smart HTTP. Everything
// deterministic: timestamps come from a fixed epoch plus a per-store sequence, ids
// are sequential, no wall clock and no randomness anywhere in state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The scenario epoch (2025-01-01T00:00:00Z): every timestamp derives from it. */
export const EPOCH_SEC = 1735689600;

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
  jsonCache: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  issueSeq: number;
  pulls: Map<number, Pull>;
  pullSeq: number;
  labels: Map<string, Label>;
  commentSeq: number;
  /** Bumped on any mutation: invalidates the cached advertisements and packs. */
  version: number;
  jsonCache: string | null;
  advCache: Map<string, Buffer>;
  packCache: Map<string, Buffer>;
}

export function isoAt(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const pieces = text.split(':');
    if (pieces.length < 2) return null;
    return { kind: pieces[0], parts: pieces.slice(1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;
  private issueIdSeq = 10000;
  private pullIdSeq = 20000;
  private commentIdSeq = 30000;
  private seq = 0;

  /** The next deterministic sequence number (timestamps, ordering). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo {
    const repo: Repo = {
      id: this.repoSeq++,
      owner,
      name,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      issueSeq: 0,
      pulls: new Map(),
      pullSeq: 0,
      labels: new Map(),
      commentSeq: 0,
      version: 0,
      jsonCache: null,
      advCache: new Map(),
      packCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The commit a ref points at (peeled through tags), or null. */
  refCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    return peelToCommit(oid, this.lookup(repo));
  }

  /** Resolve a branch name, a full ref, or an oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return this.refCommit(repo, ref);
    const branched = repo.refs.get(`refs/heads/${ref}`);
    if (branched) return peelToCommit(branched, this.lookup(repo));
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      if (object?.type === 'commit') return ref;
      if (object?.type === 'tag') return peelToCommit(ref, this.lookup(repo));
    }
    return null;
  }

  /** The file map (path -> {oid, mode}) of a commit's tree, recursively. */
  treeFiles(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the tree objects for a file map; returns the root tree oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        let child = node.dirs.get(name);
        if (!child) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object on a branch (or as the root commit). Returns its oid. */
  makeCommit(
    repo: Repo,
    options: { tree: string; parents: string[]; message: string; branch?: string },
  ): string {
    const seq = this.nextSeq();
    const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
    const data = buildCommit({
      tree: options.tree,
      parents: options.parents,
      message,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: EPOCH_SEC + seq,
    });
    const oid = this.putObject(repo, 'commit', data);
    if (options.branch) {
      repo.refs.set(`refs/heads/${options.branch}`, oid);
      repo.version += 1;
      repo.advCache.clear();
      repo.packCache.clear();
      repo.jsonCache = null;
    }
    return oid;
  }

  /** The merge-base of two commits (first common ancestor, BFS by generation). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (fromA.has(oid)) continue;
      fromA.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queueA.push(...parseCommit(object.data).parents);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (fromA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queueB.push(...parseCommit(object.data).parents);
    }
    return null;
  }

  /** Is `ancestor` reachable from `descendant` (both commits)? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const queue: string[] = [descendant];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (oid === ancestor) return true;
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return false;
  }

  // ------------------------------------------------------------ diffs & merges

  /** Files changed between two trees: path -> {status, oldOid, newOid}. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string): Map<string, { status: string; oldOid: string | null; newOid: string | null }> {
    const base = baseTree ? this.treeFiles(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
    const head = this.treeFiles(repo, headTree);
    const out = new Map<string, { status: string; oldOid: string | null; newOid: string | null }>();
    for (const [path, entry] of head) {
      const old = base.get(path);
      if (!old) out.set(path, { status: 'added', oldOid: null, newOid: entry.oid });
      else if (old.oid !== entry.oid) out.set(path, { status: 'modified', oldOid: old.oid, newOid: entry.oid });
    }
    for (const [path, entry] of base) {
      if (!head.has(path)) out.set(path, { status: 'removed', oldOid: entry.oid, newOid: null });
    }
    return out;
  }

  /**
   * Whether merging `headTip` into `baseTip` conflicts (three-way): a path changed
   * on both sides of the merge-base with different results, or changed on one side
   * and deleted on the other.
   */
  mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base === null) return false;
    const baseCommit = repo.objects.get(base);
    if (!baseCommit) return false;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headCommit = repo.objects.get(headTip);
    const baseTipCommit = repo.objects.get(baseTip);
    if (!headCommit || !baseTipCommit) return false;
    const headChanges = this.diffTrees(repo, baseTree, parseCommit(headCommit.data).tree);
    const baseChanges = this.diffTrees(repo, baseTree, parseCommit(baseTipCommit.data).tree);
    for (const [path, change] of headChanges) {
      const other = baseChanges.get(path);
      if (!other) continue;
      if (change.status === 'removed' || other.status === 'removed') {
        if (change.status !== other.status) return true;
        continue;
      }
      if (change.newOid !== other.newOid) return true;
    }
    return false;
  }

  /**
   * The squash-merged tree of `headTip` onto `baseTip`: head's changes win over
   * base's, everything else stays at base. Returns the new tree oid.
   */
  squashTree(repo: Repo, baseTip: string, headTip: string): string {
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTipCommit = repo.objects.get(baseTip)!;
    const headCommit = repo.objects.get(headTip)!;
    const baseTipTree = parseCommit(baseTipCommit.data).tree;
    const files = this.treeFiles(repo, baseTipTree);
    if (base !== null) {
      const baseCommit = repo.objects.get(base)!;
      const headChanges = this.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
      for (const [path, change] of headChanges) {
        if (change.status === 'removed') files.delete(path);
        else if (change.newOid) {
          const mode = change.status === 'added' ? '100644' : files.get(path)?.mode ?? '100644';
          files.set(path, { oid: change.newOid, mode });
        }
      }
    }
    return this.buildTreeFromFiles(repo, files);
  }

  // ------------------------------------------------------------ issues & pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = ++repo.issueSeq;
    const issue: Issue = {
      number,
      id: this.issueIdSeq++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      comments: [],
      jsonCache: null,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const number = ++repo.pullSeq;
    const pull: Pull = {
      number,
      id: this.pullIdSeq++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      head,
      base,
      headSha: repo.refs.get(`refs/heads/${head}`) ?? '',
      baseSha: repo.refs.get(`refs/heads/${base}`) ?? '',
      createdSeq: this.nextSeq(),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.commentIdSeq++, body, createdSeq: this.nextSeq() };
    issue.comments.push(comment);
    issue.jsonCache = null;
    return comment;
  }

  /** Perform a squash merge of a pull request; returns the merge commit oid or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const headTip = this.refCommit(repo, `refs/heads/${pull.head}`);
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base}`);
    if (!headTip || !baseTip) return null;
    if (this.mergeConflicts(repo, baseTip, headTip)) return null;
    const tree = this.squashTree(repo, baseTip, headTip);
    const seq = this.nextSeq();
    const mergeSha = this.makeCommit(repo, {
      tree,
      parents: [baseTip],
      message: `Merge pull request #${pull.number} from ${pull.head}`,
      branch: pull.base,
    });
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoAt(seq);
    pull.mergeSha = mergeSha;
    pull.baseSha = mergeSha;
    return mergeSha;
  }

  // ------------------------------------------------------------ serialization

  repoJson(repo: Repo): string {
    if (repo.jsonCache) return repo.jsonCache;
    const text = JSON.stringify({
      id: repo.id,
      databaseId: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      created_at: isoAt(1),
      updated_at: isoAt(1),
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    });
    repo.jsonCache = text;
    return text;
  }

  issueJson(repo: Repo, issue: Issue): string {
    if (issue.jsonCache) return issue.jsonCache;
    const text = JSON.stringify({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed' };
      }),
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      created_at: isoAt(issue.createdSeq),
      updated_at: isoAt(issue.createdSeq),
      comments: issue.comments.length,
    });
    issue.jsonCache = text;
    return text;
  }

  pullJson(repo: Repo, pull: Pull): string {
    return JSON.stringify({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeSha,
      head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
      base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      created_at: isoAt(pull.createdSeq),
      updated_at: isoAt(pull.createdSeq),
    });
  }

  invalidateIssue(issue: Issue): void {
    issue.jsonCache = null;
  }

  touchRepo(repo: Repo): void {
    repo.version += 1;
    repo.advCache.clear();
    repo.packCache.clear();
    repo.jsonCache = null;
  }
}

export { ZERO_OID, collectReachable };
