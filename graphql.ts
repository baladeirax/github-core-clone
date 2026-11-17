// GraphQL v4 (/api/graphql): a small parser + executor for exactly the documents
// the GitHub MCP server and the conformance suite send — queries, mutations,
// variables, aliases, inline fragments, named fragments, __type introspection,
// cursor pagination, and global ids. Unknown fields produce HTTP 200 errors that
// name the field. No token -> exactly 401.

import { bearerToken, type Context, type Handler } from './app.ts';
import { parseCommit } from './gitobj.ts';
import { decodeGlobalId, globalId, Store, VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';

// ------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selection: FieldNode[] | null;
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selection: FieldNode[];
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue?: ValueNode }>;
  selection: FieldNode[];
}

interface Document {
  operations: Operation[];
  fragments: Record<string, FragmentDef>;
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value} in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const document: Document = { operations: [], fragments: {} };
    while (this.peek()) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        document.operations.push({
          type: 'query',
          name: null,
          variables: {},
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value;
        const variables: Record<string, { defaultValue?: ValueNode }> = {};
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let defaultValue: ValueNode | undefined;
            if (this.acceptPunct('=')) defaultValue = this.parseValue();
            variables[varName] = { defaultValue };
          }
        }
        document.operations.push({ type, name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('Expected "on" in fragment definition');
        const typeCondition = this.expectName();
        document.fragments[name] = { name, typeCondition, selection: this.parseSelectionSet() };
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return document;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.acceptPunct('}')) {
      fields.push(this.parseField());
    }
    return fields;
  }

  private parseField(): FieldNode {
    if (this.acceptPunct('...')) {
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        this.expectName(); // type condition
        const selection = this.parseSelectionSet();
        return { alias: '', name: '__inlineFragment', args: {}, selection };
      }
      const name = this.expectName();
      return { alias: '', name: `__fragment:${name}`, args: {}, selection: null };
    }
    let alias = '';
    let name = this.expectName();
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    // Skip directives (@foo, @foo(...)) — none of the documents use them.
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selection: FieldNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias: alias === '' ? name : alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token)}`);
  }
}

// ------------------------------------------------------------------- executor

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Record<string, FragmentDef>;
  errors: { message: string }[];
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueOf(value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) out[key] = valueOf(node, variables);
  return out;
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match) return Number.parseInt(match[1], 10);
  } catch {
    // fall through
  }
  return 0;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
  ],
};

const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION'];

interface RepoView {
  repo: Repo;
}

function repoId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function issueId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

function pullId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id, pull.number);
}

function resolveSelection(
  typeName: string,
  value: unknown,
  selection: FieldNode[] | null,
  ctx: ExecContext,
): unknown {
  if (selection === null) return value;
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.name === '__inlineFragment') {
      const nested = resolveSelection(typeName, value, field.selection, ctx);
      if (nested && typeof nested === 'object') Object.assign(out, nested);
      continue;
    }
    if (field.name.startsWith('__fragment:')) {
      const fragment = ctx.fragments[field.name.slice('__fragment:'.length)];
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${field.name.slice('__fragment:'.length)}"` });
        continue;
      }
      const nested = resolveSelection(fragment.typeCondition, value, fragment.selection, ctx);
      if (nested && typeof nested === 'object') Object.assign(out, nested);
      continue;
    }
    if (field.name === '__typename') {
      out[field.alias] = typeName;
      continue;
    }
    const resolved = resolveField(typeName, value, field, ctx);
    out[field.alias] = resolved;
  }
  return out;
}

function unknownField(typeName: string, field: FieldNode, ctx: ExecContext): null {
  ctx.errors.push({ message: `Field "${field.name}" doesn't exist on type "${typeName}"` });
  return null;
}

function resolveField(typeName: string, value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(field, ctx.variables);
  switch (typeName) {
    case 'Query':
      return resolveQueryField(field, args, ctx);
    case 'Mutation':
      return resolveMutationField(field, args, ctx);
    case 'Repository':
      return resolveRepositoryField((value as RepoView).repo, field, args, ctx);
    case 'Issue':
      return resolveIssueField(field, value as { repo: Repo; issue: Issue }, ctx);
    case 'PullRequest':
      return resolvePullRequestField(field, value as { repo: Repo; pull: Pull }, ctx);
    case 'User':
      return resolveUserField(field, ctx);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
      return resolveConnectionField(typeName, field, value as { nodes: unknown[]; nodeType: string; endCursor: string | null; hasNextPage: boolean }, ctx);
    case 'PageInfo':
      return resolvePageInfoField(field, value as { endCursor: string | null; hasNextPage: boolean }, ctx);
    case 'BranchRef':
      return resolveBranchRefField(field, value as { name: string }, ctx);
    case '__Type':
      return resolveTypeField(field, value as { name: string }, ctx);
    case '__Field':
      return resolveFieldTypeField(field, value as { name: string }, ctx);
    case 'CommentEdge':
      return resolveCommentEdgeField(field, value as { node: { id: string; body: string } }, ctx);
    case 'IssueComment':
      return resolveCommentField(field, value as { id: string; body: string }, ctx);
    case 'PullRequestFile': {
      const file = value as { path: string };
      if (field.name === 'path') return file.path;
      return unknownField('PullRequestFile', field, ctx);
    }
    case 'Edge': {
      const edge = value as { node: unknown; nodeType: string };
      if (field.name === 'node') return resolveSelection(edge.nodeType, edge.node, field.selection, ctx);
      if (field.name === 'cursor') return null;
      return unknownField('Edge', field, ctx);
    }
    case '__EnumValue': {
      const enumValue = value as { name: string };
      if (field.name === 'name') return enumValue.name;
      return unknownField('__EnumValue', field, ctx);
    }
    default:
      return unknownField(typeName, field, ctx);
  }
}

function resolveQueryField(field: FieldNode, args: Record<string, unknown>, ctx: ExecContext): unknown {
  if (field.name === 'viewer') {
    return resolveSelection('User', { login: VIEWER_LOGIN }, field.selection, ctx);
  }
  if (field.name === 'repository') {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) return null;
    return resolveSelection('Repository', { repo }, field.selection, ctx);
  }
  if (field.name === 'node') {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'Repository') return null;
    const repo = ctx.store.getRepoById(Number(decoded.parts[0]));
    if (!repo) return null;
    return resolveSelection('Repository', { repo }, field.selection, ctx);
  }
  if (field.name === '__type') {
    const name = args.name;
    if (typeof name !== 'string') return null;
    if (!TYPE_FIELDS[name] && name !== 'SearchType') return null;
    return resolveSelection('__Type', { name }, field.selection, ctx);
  }
  if (field.name === '__schema') {
    return resolveSelection('__Schema', {}, field.selection, ctx);
  }
  return unknownField('Query', field, ctx);
}

function resolveMutationField(field: FieldNode, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === 'createIssue') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    if (!repo || typeof input.title !== 'string') {
      ctx.errors.push({ message: 'createIssue: repository not found or title missing' });
      return null;
    }
    const issue = ctx.store.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
    const payload = { issue: resolveSelection('Issue', { repo, issue }, field.selection?.find((f) => f.name === 'issue')?.selection ?? null, ctx) };
    return payload;
  }
  if (field.name === 'closeIssue') {
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    const repo = decoded?.kind === 'Issue' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.get(Number(decoded?.parts[1]));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    issue.state = 'closed';
    ctx.store.invalidateIssue(issue);
    const sub = field.selection?.find((f) => f.name === 'issue');
    return { issue: resolveSelection('Issue', { repo, issue }, sub?.selection ?? null, ctx) };
  }
  if (field.name === 'createPullRequest') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    const head = input.headRefName;
    const base = input.baseRefName;
    if (!repo || typeof head !== 'string' || typeof base !== 'string' || typeof input.title !== 'string') {
      ctx.errors.push({ message: 'createPullRequest: repository or branches missing' });
      return null;
    }
    const headTip = ctx.store.refCommit(repo, `refs/heads/${head}`);
    const baseTip = ctx.store.refCommit(repo, `refs/heads/${base}`);
    if (!headTip || !baseTip) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
      return null;
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head === head && existing.base === base) {
        ctx.errors.push({ message: 'A pull request already exists for this head and base' });
        return null;
      }
    }
    const pull = ctx.store.createPull(repo, input.title, typeof input.body === 'string' ? input.body : '', head, base);
    pull.headSha = headTip;
    pull.baseSha = baseTip;
    const sub = field.selection?.find((f) => f.name === 'pullRequest');
    return { pullRequest: resolveSelection('PullRequest', { repo, pull }, sub?.selection ?? null, ctx) };
  }
  if (field.name === 'mergePullRequest') {
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    const repo = decoded?.kind === 'PullRequest' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    const pull = repo?.pulls.get(Number(decoded?.parts[1]));
    if (!repo || !pull) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    if (pull.state !== 'open') {
      ctx.errors.push({ message: 'mergePullRequest: pull request is already closed' });
      return null;
    }
    const headTip = ctx.store.refCommit(repo, `refs/heads/${pull.head}`);
    const baseTip = ctx.store.refCommit(repo, `refs/heads/${pull.base}`);
    if (!headTip || !baseTip) {
      ctx.errors.push({ message: 'mergePullRequest: head or base branch does not exist' });
      return null;
    }
    if (ctx.store.mergeConflicts(repo, baseTip, headTip)) {
      ctx.errors.push({ message: 'mergePullRequest: pull request has merge conflicts' });
      return null;
    }
    ctx.store.squashMerge(repo, pull);
    const sub = field.selection?.find((f) => f.name === 'pullRequest');
    return { pullRequest: resolveSelection('PullRequest', { repo, pull }, sub?.selection ?? null, ctx) };
  }
  if (field.name === 'addComment') {
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    const repo = decoded?.kind === 'Issue' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.get(Number(decoded?.parts[1]));
    if (!repo || !issue || typeof input.body !== 'string') {
      ctx.errors.push({ message: 'addComment: issue not found or body missing' });
      return null;
    }
    const comment = ctx.store.addComment(repo, issue, input.body);
    const node = { id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body };
    const edgeField = field.selection?.find((f) => f.name === 'commentEdge');
    const edge = resolveSelection('CommentEdge', { node }, edgeField?.selection ?? null, ctx);
    return { commentEdge: edge };
  }
  return unknownField('Mutation', field, ctx);
}

function resolveRepositoryField(repo: Repo, field: FieldNode, args: Record<string, unknown>, ctx: ExecContext): unknown {
  switch (field.name) {
    case 'id':
      return repoId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return resolveSelection('User', { login: repo.owner }, field.selection, ctx);
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return resolveSelection('BranchRef', { name: repo.defaultBranch }, field.selection, ctx);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      if (!issue) return null;
      return resolveSelection('Issue', { repo, issue }, field.selection, ctx);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction === 'DESC' ? -1 : 1;
      issues.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
      return paginateIssues(repo, issues, args, ctx, field);
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()];
      pulls.sort((a, b) => a.createdSeq - b.createdSeq);
      const first = typeof args.first === 'number' ? args.first : pulls.length;
      const nodes = pulls.slice(0, first).map((pull) => ({ repo, pull }));
      return resolveSelection(
        'PullRequestConnection',
        { nodes, nodeType: 'PullRequest', endCursor: null, hasNextPage: false },
        field.selection,
        ctx,
      );
    }
    case 'pullRequest': {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      if (!pull) return null;
      return resolveSelection('PullRequest', { repo, pull }, field.selection, ctx);
    }
    default:
      return unknownField('Repository', field, ctx);
  }
}

function paginateIssues(
  repo: Repo,
  issues: Issue[],
  args: Record<string, unknown>,
  ctx: ExecContext,
  field: FieldNode,
): unknown {
  const after = decodeCursor(args.after);
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const filtered = issues.filter((issue) => issue.number > after);
  const page = filtered.slice(0, first);
  const hasNextPage = filtered.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const nodes = page.map((issue) => ({ repo, issue }));
  return resolveSelection(
    'IssueConnection',
    { nodes, nodeType: 'Issue', endCursor, hasNextPage },
    field.selection,
    ctx,
  );
}

function resolveIssueField(field: FieldNode, value: { repo: Repo; issue: Issue }, ctx: ExecContext): unknown {
  const { repo, issue } = value;
  switch (field.name) {
    case 'id':
      return issueId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'body':
      return issue.body;
    default:
      return unknownField('Issue', field, ctx);
  }
}

function resolvePullRequestField(field: FieldNode, value: { repo: Repo; pull: Pull }, ctx: ExecContext): unknown {
  const { repo, pull } = value;
  switch (field.name) {
    case 'id':
      return pullId(repo, pull);
    case 'number':
      return pull.number;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.head;
    case 'baseRefName':
      return pull.base;
    case 'mergeable': {
      const headTip = ctx.store.refCommit(repo, `refs/heads/${pull.head}`);
      const baseTip = ctx.store.refCommit(repo, `refs/heads/${pull.base}`);
      if (!headTip || !baseTip) return 'UNKNOWN';
      return ctx.store.mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'files': {
      const headTip = ctx.store.refCommit(repo, `refs/heads/${pull.head}`);
      const baseTip = ctx.store.refCommit(repo, `refs/heads/${pull.base}`);
      if (!headTip || !baseTip) {
        return resolveSelection('PullRequestFileConnection', { nodes: [], nodeType: 'PullRequestFile', endCursor: null, hasNextPage: false }, field.selection, ctx);
      }
      const base = ctx.store.mergeBase(repo, baseTip, headTip);
      const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
      const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
      const diff = ctx.store.diffTrees(repo, baseTree, headTree);
      const nodes = [...diff.keys()].sort().map((path) => ({ path }));
      return resolveSelection('PullRequestFileConnection', { nodes, nodeType: 'PullRequestFile', endCursor: null, hasNextPage: false }, field.selection, ctx);
    }
    default:
      return unknownField('PullRequest', field, ctx);
  }
}

function resolveUserField(field: FieldNode, ctx: ExecContext): unknown {
  if (field.name === 'login') return VIEWER_LOGIN;
  return unknownField('User', field, ctx);
}

function resolveConnectionField(
  typeName: string,
  field: FieldNode,
  value: { nodes: unknown[]; nodeType: string; endCursor: string | null; hasNextPage: boolean },
  ctx: ExecContext,
): unknown {
  if (field.name === 'nodes') {
    const selection = field.selection;
    if (!selection) return value.nodes;
    return value.nodes.map((node) => resolveSelection(value.nodeType, node, selection, ctx));
  }
  if (field.name === 'edges') {
    const selection = field.selection;
    if (!selection) return value.nodes.map((node) => ({ node }));
    return value.nodes.map((node) => resolveSelection('Edge', { node, nodeType: value.nodeType }, selection, ctx));
  }
  if (field.name === 'pageInfo') {
    return resolveSelection('PageInfo', { endCursor: value.endCursor, hasNextPage: value.hasNextPage }, field.selection, ctx);
  }
  return unknownField(typeName, field, ctx);
}

function resolvePageInfoField(field: FieldNode, value: { endCursor: string | null; hasNextPage: boolean }, ctx: ExecContext): unknown {
  if (field.name === 'hasNextPage') return value.hasNextPage;
  if (field.name === 'endCursor') return value.endCursor;
  return unknownField('PageInfo', field, ctx);
}

function resolveBranchRefField(field: FieldNode, value: { name: string }, ctx: ExecContext): unknown {
  if (field.name === 'name') return value.name;
  return unknownField('BranchRef', field, ctx);
}

function resolveTypeField(field: FieldNode, value: { name: string }, ctx: ExecContext): unknown {
  const { name } = value;
  if (field.name === 'name') return name;
  if (field.name === 'kind') return name === 'SearchType' ? 'ENUM' : 'OBJECT';
  if (field.name === 'fields') {
    const names = TYPE_FIELDS[name] ?? [];
    const selection = field.selection;
    if (!selection) return names.map((fieldName) => ({ name: fieldName }));
    return names.map((fieldName) => resolveSelection('__Field', { name: fieldName }, selection, ctx));
  }
  if (field.name === 'enumValues') {
    if (name !== 'SearchType') return null;
    const selection = field.selection;
    if (!selection) return SEARCH_ENUM.map((enumName) => ({ name: enumName }));
    return SEARCH_ENUM.map((enumName) => resolveSelection('__EnumValue', { name: enumName }, selection, ctx));
  }
  return unknownField('__Type', field, ctx);
}

function resolveFieldTypeField(field: FieldNode, value: { name: string }, ctx: ExecContext): unknown {
  if (field.name === 'name') return value.name;
  return unknownField('__Field', field, ctx);
}

function resolveCommentEdgeField(field: FieldNode, value: { node: { id: string; body: string } }, ctx: ExecContext): unknown {
  if (field.name === 'node') return resolveSelection('IssueComment', value.node, field.selection, ctx);
  return unknownField('CommentEdge', field, ctx);
}

function resolveCommentField(field: FieldNode, value: { id: string; body: string }, ctx: ExecContext): unknown {
  if (field.name === 'id') return value.id;
  if (field.name === 'body') return value.body;
  return unknownField('IssueComment', field, ctx);
}

// ------------------------------------------------------------------- handler

function executeOne(store: Store, document: Document, request: { operationName?: unknown; variables?: unknown }): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const operation =
    document.operations.find((op) => typeof request.operationName === 'string' && op.name === request.operationName) ??
    document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation in GraphQL document' }] };
  const variables: Record<string, unknown> = {};
  if (request.variables && typeof request.variables === 'object') {
    Object.assign(variables, request.variables as Record<string, unknown>);
  }
  for (const [name, def] of Object.entries(operation.variables)) {
    if (variables[name] === undefined && def.defaultValue) {
      variables[name] = valueOf(def.defaultValue, variables);
    }
  }
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelection(rootType, {}, operation.selection, ctx) as Record<string, unknown>;
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export const graphqlHandler: Handler = async (ctx) => {
  if (ctx.path !== '/api/graphql') return false;
  if (ctx.method !== 'POST') {
    ctx.error(405, 'Method Not Allowed');
    return true;
  }
  if (!bearerToken(ctx.req)) {
    ctx.json(401, { errors: [{ message: 'Requires authentication' }] });
    return true;
  }
  let request: unknown;
  try {
    request = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    ctx.json(400, { errors: [{ message: 'Invalid JSON' }] });
    return true;
  }
  const run = (item: unknown): { data: Record<string, unknown> | null; errors?: { message: string }[] } => {
    if (typeof item !== 'object' || item === null) return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    const body = item as { query?: unknown; operationName?: unknown; variables?: unknown };
    if (typeof body.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    let document: Document;
    try {
      document = new Parser(tokenize(body.query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Failed to parse query' }] };
    }
    return executeOne(ctx.store, document, body);
  };
  if (Array.isArray(request)) {
    ctx.json(200, request.map(run));
    return true;
  }
  ctx.json(200, run(request));
  return true;
};
