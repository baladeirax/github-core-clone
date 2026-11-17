// Git smart HTTP: upload-pack protocol v2 (ls-refs, fetch) and v0 advertisements,
// receive-pack v0 with report-status / side-band-64k / delete-refs. Packs are
// plain objects (no deltas); reads resolve OFS/REF deltas and thin packs.

import { type Context, type Handler } from './app.ts';
import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { VIEWER_LOGIN, type Repo } from './store.ts';

const UPLOAD_V2_CAPS = ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function repoAt(ctx: Context, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

/** All refs sorted lexicographically, plus peeled tag lines. */
function refLines(repo: Repo): { oid: string; ref: string }[] {
  const lines: { oid: string; ref: string }[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const ref of names) {
    const oid = repo.refs.get(ref)!;
    lines.push({ oid, ref });
    if (ref.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(oid, (id) => repo.objects.get(id));
        if (peeled) lines.push({ oid: peeled, ref: `${ref}^{}` });
      }
    }
  }
  return lines;
}

function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const caps = service === 'upload' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const serviceName = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const lines = refLines(repo);
  const parts: Buffer[] = [encodePktLine(`# service=${serviceName}\n`), pktFlush()];
  if (lines.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const headOid = headTip ? peelToCommit(headTip, (id) => repo.objects.get(id)) ?? headTip : null;
    if (headOid) parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    else parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    for (const line of lines) parts.push(encodePktLine(`${line.oid} ${line.ref}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines: (string | 'flush')[] = ['version 2\n', ...UPLOAD_V2_CAPS.map((cap) => `${cap}\n`), 'flush'];
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- fetch

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number;
  thinPack: boolean;
  ofsDelta: boolean;
}

/** Objects reachable from `roots` without leaving the `included` commit set. */
function reachableFromIncluded(repo: Repo, included: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...included];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) if (included.has(parent)) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Objects reachable from `roots`, not traversing parents of `cutoff` commits. */
function closureWithCutoff(repo: Repo, roots: Iterable<string>, cutoff: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!cutoff.has(oid)) queue.push(...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

function planFetch(repo: Repo, plan: FetchPlan): { objects: GitObject[]; shallow: string[]; unshallow: string[]; ack: string | null } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveSet = new Set(plan.haves);
  const prevShallow = new Set(plan.shallow);
  const included = new Map<string, number>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const visited = new Set<string>();
  const queue: { oid: string; gen: number }[] = [];
  const extraObjects = new Set<string>();
  for (const want of plan.wants) {
    // Tag wants travel with their tag objects.
    let current = want;
    for (let i = 0; i < 16; i += 1) {
      const object = lookup(current);
      if (!object) break;
      if (object.type === 'tag') {
        extraObjects.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      break;
    }
    const commit = peelToCommit(want, lookup);
    if (commit) queue.push({ oid: commit, gen: 0 });
  }
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (haveSet.has(oid)) {
      if (prevShallow.has(oid)) {
        if (plan.depth === 0 || gen + 1 < plan.depth) {
          unshallow.add(oid);
          for (const parent of parents) queue.push({ oid: parent, gen: gen + 1 });
        } else {
          shallow.add(oid);
        }
      }
      continue;
    }
    if (plan.depth > 0 && gen >= plan.depth) continue;
    included.set(oid, gen);
    for (const parent of parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  if (plan.depth > 0) {
    for (const [oid, gen] of included) {
      if (gen !== plan.depth - 1) continue;
      const object = lookup(oid);
      if (object?.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.add(oid);
    }
  }
  const reachable = reachableFromIncluded(repo, new Set(included.keys()));
  for (const oid of extraObjects) reachable.add(oid);
  const haveClosure = closureWithCutoff(repo, haveSet, prevShallow);
  const objects: GitObject[] = [];
  for (const oid of reachable) {
    if (haveClosure.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  let ack: string | null = null;
  for (const have of plan.haves) {
    if (lookup(have)) {
      ack = have;
      break;
    }
  }
  return { objects, shallow: [...shallow].sort(), unshallow: [...unshallow].sort(), ack };
}

function sidebandPack(pack: Buffer): Buffer {
  // A pkt-line carries at most 65516 payload bytes; one of those is the band
  // byte, so at most 65515 bytes of pack data go in each packet.
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(offset + 65515, pack.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, plan: FetchPlan): Buffer {
  const result = planFetch(repo, plan);
  const pack = writePack(result.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine(result.ack ? `ACK ${result.ack}\n` : 'NAK\n'));
  parts.push(pktDelim());
  if (plan.depth > 0 || plan.shallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- handlers

function parseArgs(packets: ReturnType<typeof decodePktLines>['packets']): string[] {
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    // The first line may carry "\0<capabilities>" after the command.
    const nul = text.indexOf('\0');
    args.push((nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, ''));
  }
  return args;
}

const gitHandler: Handler = async (ctx) => {
  const seg = ctx.segments;
  if (seg.length < 2 || !seg[1].endsWith('.git')) return false;
  const owner = seg[0];
  const repoName = seg[1].slice(0, -'.git'.length);
  const tail = seg.slice(2);
  const repo = repoAt(ctx, owner, repoName);
  if (!repo) {
    ctx.text(404, 'Not Found', 'text/plain');
    return true;
  }

  // GET info/refs?service=...
  if (ctx.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.url.searchParams.get('service');
    const cacheKey = service === 'git-receive-pack' ? 'receive:v0' : ctx.req.headers['git-protocol'] === 'version=2' ? 'upload:v2' : 'upload:v0';
    const cached = repo.advCache.get(cacheKey);
    if (cached) {
      ctx.text(
        200,
        cached,
        service === 'git-receive-pack' ? 'application/x-git-receive-pack-advertisement' : 'application/x-git-upload-pack-advertisement',
      );
      return true;
    }
    let body: Buffer;
    let contentType: string;
    if (service === 'git-receive-pack') {
      body = v0Advertisement(repo, 'receive');
      contentType = 'application/x-git-receive-pack-advertisement';
    } else if (service === 'git-upload-pack') {
      if (ctx.req.headers['git-protocol'] === 'version=2') {
        body = v2Advertisement();
      } else {
        body = v0Advertisement(repo, 'upload');
      }
      contentType = 'application/x-git-upload-pack-advertisement';
    } else {
      ctx.text(400, 'Bad Request', 'text/plain');
      return true;
    }
    repo.advCache.set(cacheKey, body);
    ctx.text(200, body, contentType);
    return true;
  }

  // POST git-upload-pack
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const cacheKey = `fetch:${repo.version}:${ctx.body.toString('hex')}`;
    const cached = repo.packCache.get(cacheKey);
    if (cached) {
      ctx.text(200, cached, 'application/x-git-upload-pack-result');
      return true;
    }
    let response: Buffer;
    try {
      const { packets } = decodePktLines(ctx.body);
      const args = parseArgs(packets);
      const command = args.find((arg) => arg.startsWith('command='))?.slice('command='.length);
      if (command === 'ls-refs') {
        const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
        const wantPeel = args.includes('peel');
        const wantSymrefs = args.includes('symrefs');
        const wantUnborn = args.includes('unborn');
        const lines: string[] = [];
        const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
        const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        const headCommit = headTip ? peelToCommit(headTip, (id) => repo.objects.get(id)) : null;
        if (headCommit && matches('HEAD')) {
          lines.push(wantSymrefs ? `${headCommit} HEAD symref-target:refs/heads/main` : `${headCommit} HEAD`);
        } else if (!headCommit && wantUnborn && matches('HEAD')) {
          lines.push(wantSymrefs ? 'unborn HEAD symref-target:refs/heads/main' : 'unborn HEAD');
        }
        for (const line of refLines(repo)) {
          if (!matches(line.ref)) continue;
          // Peeled tag pseudo-refs are a v0 advertisement construct; in
          // ls-refs a peeled commit travels as an attribute on the tag line.
          if (line.ref.endsWith('^{}')) continue;
          let text = `${line.oid} ${line.ref}`;
          if (wantPeel && line.ref.startsWith('refs/tags/')) {
            const object = repo.objects.get(line.oid);
            if (object?.type === 'tag') {
              const peeled = peelToCommit(line.oid, (id) => repo.objects.get(id));
              if (peeled) text += ` peeled:${peeled}`;
            }
          }
          lines.push(text);
        }
        response = encodePktLines([...lines, 'flush']);
      } else if (command === 'fetch') {
        const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: 0, thinPack: false, ofsDelta: false };
        for (const arg of args) {
          if (arg.startsWith('want ')) plan.wants.push(arg.slice(5));
          else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5));
          else if (arg.startsWith('shallow ')) plan.shallow.push(arg.slice(8));
          else if (arg.startsWith('deepen ')) plan.depth = Number.parseInt(arg.slice(7), 10) || 0;
          else if (arg === 'thin-pack') plan.thinPack = true;
          else if (arg === 'ofs-delta') plan.ofsDelta = true;
        }
        response = fetchResponse(repo, plan);
      } else {
        // Protocol v0 upload-pack: want/have lines, no command.
        const wants: string[] = [];
        const haves: string[] = [];
        for (const arg of args) {
          if (arg.startsWith('want ')) wants.push(arg.slice(5).split(' ')[0]);
          else if (arg.startsWith('have ')) haves.push(arg.slice(5));
        }
        const plan: FetchPlan = { wants, haves, shallow: [], depth: 0, thinPack: false, ofsDelta: false };
        const result = planFetch(repo, plan);
        const pack = writePack(result.objects);
        response = Buffer.concat([encodePktLine('NAK\n'), sidebandPack(pack), pktFlush()]);
      }
    } catch {
      // A malformed upload-pack body must never take the server down.
      response = encodePktLines(['ERR malformed request\n', 'flush']);
    }
    repo.packCache.set(cacheKey, response);
    ctx.text(200, response, 'application/x-git-upload-pack-result');
    return true;
  }

  // POST git-receive-pack (v0 only)
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    let statuses: string[] = [];
    try {
      const { packets, endOffset } = decodePktLines(ctx.body);
      const args = parseArgs(packets);
      const commands: { oldOid: string; newOid: string; ref: string }[] = [];
      for (const arg of args) {
        const parts = arg.split(' ');
        if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
          commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
        }
      }
      // Store the pushed pack first (even refs that later fail keep their objects).
      const packBytes = ctx.body.subarray(endOffset);
      if (packBytes.length > 0) {
        const pack = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, object] of pack.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      }
      for (const command of commands) {
        const current = repo.refs.get(command.ref);
        if (command.newOid === ZERO_OID) {
          if (!current) {
            statuses.push(`ng ${command.ref} remote ref does not exist`);
          } else {
            repo.refs.delete(command.ref);
            statuses.push(`ok ${command.ref}`);
          }
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          statuses.push(`ng ${command.ref} object ${command.newOid} is missing`);
          continue;
        }
        if (command.oldOid === ZERO_OID) {
          if (current) {
            statuses.push(`ng ${command.ref} already exists`);
          } else {
            repo.refs.set(command.ref, command.newOid);
            statuses.push(`ok ${command.ref}`);
          }
          continue;
        }
        if (current !== command.oldOid) {
          statuses.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        const newCommit = peelToCommit(command.newOid, (id) => repo.objects.get(id));
        const oldCommit = peelToCommit(command.oldOid, (id) => repo.objects.get(id));
        if (newCommit && oldCommit && !ctx.store.isAncestor(repo, oldCommit, newCommit)) {
          statuses.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        statuses.push(`ok ${command.ref}`);
      }
      if (commands.length > 0) ctx.store.touchRepo(repo);
    } catch {
      // Malformed receive-pack bodies are answered, never fatal.
      statuses = [];
    }
    const lines: Buffer[] = [encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from('unpack ok\n', 'utf8')]))];
    for (const status of statuses) {
      lines.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${status}\n`, 'utf8')])));
    }
    lines.push(pktFlush());
    ctx.text(200, Buffer.concat(lines), 'application/x-git-receive-pack-result');
    return true;
  }

  return false;
};

export { gitHandler };
