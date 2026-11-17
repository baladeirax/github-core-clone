# forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/baladeirax/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/baladeirax/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A one-process, GitHub-compatible git forge in pure Node 22 TypeScript (stdlib
only). No UI, no outside service, no git binary, no install step.

Run it with `npm start` (`node --experimental-strip-types main.ts`); it binds an
ephemeral port, registers with the trial environment at `$MAKEFUN_ENV_URL`, serves
until the environment says the trial is done, then exits 0.

## Surfaces (one shared, deterministic store)

- **REST v3** at `/api/v3` — repos, branches, commits, contents, labels, issues,
  comments, pull requests and squash merges. Every reply carries
  `X-GitHub-Request-Id`; no token → 401; a foreign owner → 404, never 403.
- **GraphQL v4** at `/api/graphql` — the exact documents the GitHub MCP server
  sends: viewer, repository, issues, pull requests, `__type` introspection,
  cursor pagination, global ids, and the create/close/merge/comment mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, protocol revision 2026-07-28
  (with the legacy initialize handshake): `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.
- **Git smart HTTP** — upload-pack protocol v2 (`ls-refs`, `fetch`, shallow
  clones with `deepen`) and v0 advertisements, receive-pack v0 with
  `report-status` / `side-band-64k` / `delete-refs`; non-fast-forward pushes are
  refused per-ref. Packs are plain objects (no deltas); reads resolve OFS/REF
  deltas and thin packs.

## Determinism

State is byte-identical across runs: timestamps derive from a fixed epoch plus a
sequence counter, ids are sequential, and no wall clock or unseeded randomness
appears anywhere in state.

## Layout

- `main.ts` — entry point and env lifecycle
- `app.ts` — HTTP plumbing, routing, auth, request ids
- `store.ts` — repositories, objects, refs, issues, pull requests, merges
- `gitobj.ts` — git objects, packfiles, pkt-lines
- `git.ts` — smart HTTP
- `rest.ts` — REST v3
- `graphql.ts` — GraphQL v4 (parser + executor)
- `mcp.ts` — MCP tools

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

Use my referral link to try make.fun: https://make.fun/r/1b9vagm7
