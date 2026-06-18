# AGENTS.md — Atlas Vector

## What this repo is

A fork of **pingdotgg/t3code** (`@t3tools/monorepo`, "T3 Code") being turned into
**Atlas Vector** — Atlas's hosted, multi-user, AI investment-banking document workspace.
We keep T3's agent UX (Codex/Claude chat with mid-run steering) and re-skin it to Atlas,
then add Vector's domain features by **calling a separate FastAPI backend that already
exists** — the sibling **`vector` repo** (`github.com/atlasinc-global/vector`), checked
out next to this one at `../vector` (FastAPI at `../vector/apps/api`). This repo's own
origin is `github.com/atlasinc-global/vector-workspace`. It runs locally on one machine
via `docker compose` and deploys to GCP like the rest of Vector.

> **RULE #1 governs everything below: stay rebaseable on upstream T3.** Whenever guidance
> here conflicts with keeping clean rebases against upstream, Rule #1 wins.

## RULE #1 — stay rebaseable on upstream T3

We must pull `pingdotgg/t3code` updates forever. Therefore:

- `git remote add upstream https://github.com/pingdotgg/t3code` (once). Rebase/merge
  `upstream/main` regularly; the fork must always build against latest upstream.
- **Do NOT edit upstream files unless unavoidable.** Put ALL customization in NEW,
  `atlas-*`-namespaced files/dirs/packages:
  - **Theme** → `packages/atlas-theme/`: CSS-variable overrides imported **after** T3's
    `apps/web/src/index.css`. Atlas logos in `assets/atlas/`.
  - **App name/title** → an env/override layer (a new `VITE_ATLAS_*` var, or the
    desktop-branding injection `apps/web/src/branding.ts` already reads), **not** by
    editing `branding.ts`.
  - **Backend client + Atlas screens** → `packages/atlas-backend/` (typed FastAPI client)
    + a namespaced web route group. Never edit `packages/contracts` (T3's RPC schema);
    Atlas additions go in `packages/atlas-contracts/`.
  - **Hiding coding-IDE surfaces** → env-driven feature flags, never deletions.
  - **Config** → `ATLAS_*` / `VITE_ATLAS_*` env vars.
- If an upstream file MUST change, make the **smallest possible diff** and log it in
  **`FORK-CHANGES.md`** (file · why · how to re-apply after rebase). That ledger is what
  keeps rebases cheap — keep it accurate.
- Before any upstream merge: typecheck + lint + build + tests; resolve conflicts; update
  the ledger.

## Architecture — two backends, one compose

**T3 side (kept, re-skinned).** `apps/web` + `apps/server` own the agent loop: chat,
reasoning/tool stream, **mid-run steering** (turn/steer), file edits. `apps/server` is a
Node WebSocket server wrapping the Codex app-server. Coding-IDE surfaces (terminal, git
worktrees, source-control diffs, multi-repo) are **hidden by default via feature flags —
keep the code, hide the UI.**

**Vector side (reused, separate `../vector` service).** The existing FastAPI (+ Postgres +
Elasticsearch + Redis) owns the domain. It already exists and is tested (**88 green**
pytest in `../vector/apps/api`) — **do not rebuild it in TypeScript, call it.** It owns:
identity (JWT — **source of truth for users**); deals/workspaces (a "deal" *is* a
workspace); per-workspace membership/access-control (owner/member/viewer); dataroom
documents (Google Drive link/sync + upload/edit); Elasticsearch **hybrid RAG** (BM25 +
embeddings) for grounding; intake; voice transcription; audit; ops/health.

**Web talks to both.** `VITE_WS_URL` / `VITE_HTTP_URL` → T3 server (agent); new
`VITE_ATLAS_API_URL` → FastAPI (login + deals + dataroom + RAG + members). The user logs
in against FastAPI (JWT); the agent session is established behind that login. (Real T3 env
names live in `apps/web/src/environments/primary/target.ts` and `apps/web/src/vite-env.d.ts`.)

**The key seam — shared workspace directory.** Each deal maps to a workspace directory on
a shared volume. In Vector's compose the `api` service already mounts a `workspaces`
volume at `/workspaces` (`WORKSPACES_ROOT=/workspaces`, `CODEX_HOME=/workspaces/.codex`,
`CLAUDE_CONFIG_DIR=/workspaces/.claude`) with a per-workspace **git ledger**. FastAPI syncs
the deal's dataroom files into that directory; **T3's server must mount the same volume and
run the codex agent in that same directory**; FastAPI supplies ES hybrid-RAG retrieval over
the deal's files as grounding context. **This shared-workspace bridge is the riskiest part
— get it right first.**

**One compose, runs everywhere.** ONE `docker compose` brings up web + T3 server + the
FastAPI + Postgres + ES + Redis on this machine; the same images deploy to GCP. **Reuse
Vector's root `../vector/docker-compose.yml`** services (`db` = postgres:16, `es` =
elasticsearch:8.17.4, `redis` = redis:7, `api` = FastAPI on :8000) rather than redefining
them. Multi-instance-ready (FastAPI already does Redis-backed WS fan-out).

**The overlap, and the rule that resolves it.** Vector *also* ships its own simple web
frontend and its own Codex/Claude run loop (`/api/runs`, `/api/agents/connect`,
`/api/deals/{id}/chat-threads`, a WS manager). **For the conversation UX we use T3's loop;
we use FastAPI only for identity, deals, documents, and RAG grounding.** Do not wire the
web app to FastAPI's run loop.

## The Atlas aesthetic (incremental, via the theme layer)

Match Vector's existing Atlas look — **navy primary `#212847`**, cool grays, **Inter**, the
"Atlas Vector" logo. Canonical tokens live in Vector's `frontend/core` submodule
(`atlasinc-global/frontend-core`, the Atlas design system) — read values from there, don't
reinvent them. Apply through T3's CSS-variable tokens + logo/branding swap in
`packages/atlas-theme/` and `assets/atlas/`. Go incrementally: (1) logo + app name +
primary/accent, (2) full palette + Inter (replacing DM Sans), (3) deeper component polish
only as needed. No bespoke from-scratch redesign — restyle via tokens so upstream component
updates still apply.

## Conventions

- **TS/Effect** on the T3 side; **Python/FastAPI stays Python** on the domain side. New TS
  code under `atlas-*` packages (`packages/atlas-theme`, `packages/atlas-backend`,
  `packages/atlas-contracts`).
- **Verify every change.** T3 side → `vp check` + `vp run typecheck` (+ `vp test`);
  backend → its pytest suite (currently **88 green**, in `../vector/apps/api`); end-to-end
  → `docker compose up`. `vp` = vite-plus; pnpm@10.24.0 is the package manager; Node
  ^24.13.1. Run `pnpm install` first — `node_modules` is not committed.
- Treat the FastAPI as a **stable API with its own tests** (separate repo); coordinate any
  contract change deliberately. Keep `FORK-CHANGES.md` current. Keep changes small and
  themed.

## Vector FastAPI feature map (what to call, not rebuild)

All routers are mounted under `/api` (`../vector/apps/api/app/main.py`).

- **Auth:** `POST /api/auth/login` (JWT) · `GET /api/auth/me` · members
  `GET`/`POST /api/deals/{id}/members`, `DELETE /api/deals/{id}/members/{member_id}`
  (owner/member/viewer).
- **Deals (= workspaces):** `GET /api/deals` (scoped to membership) · `GET /api/deals/{id}`
  · stage · `GET /api/deals/{id}/audit`.
- **Dataroom/files:** `GET /api/deals/{id}/files` · `GET`/`PUT /api/deals/{id}/files/{path}`
  (download/edit) · Drive link `PUT /api/deals/{id}/dataroom` +
  `POST /api/deals/{id}/dataroom/sync`.
- **RAG:** Elasticsearch hybrid (BM25 + embeddings) retrieval to ground chat over a deal's
  files (`../vector/apps/api/app/search`).
- **Voice:** `POST /api/transcribe`. **Intake:** `/api/intake/*`. **Ops:**
  `GET /api/health` (liveness), `GET /api/ready` (Postgres hard / ES soft); JSON logs;
  Redis-backed WS fan-out.
- FastAPI also has its own codex run loop (`/api/runs`, `/api/agents/connect`,
  `/api/deals/{id}/chat-threads`) — **prefer T3's loop for the conversation UX** and use
  FastAPI for identity, deals, documents, and RAG grounding.

## Upstream T3 essentials (preserved from T3's original AGENTS.md)

- **Gate:** `vp check` and `vp run typecheck` must pass before a task is done
  (`vp run lint:mobile` if native mobile changes); `vp test` for the built-in Vite+ test
  command, `vp run test` when you specifically need the `test` package script.
- **Priorities:** performance, reliability, predictable behavior under load/failure
  (session restarts, reconnects, partial streams); correctness/robustness over short-term
  convenience.
- **Maintainability:** first check for shared logic to extract; duplicate logic across
  files is a code smell. Don't be afraid to change existing code; don't take local-shortcut
  hacks.
- **Package roles:** `apps/server` (Node WS server wrapping Codex app-server),
  `apps/web` (React/Vite UI), `packages/contracts` (effect/Schema, schema-only — no runtime
  logic), `packages/shared` (explicit subpath exports e.g. `@t3tools/shared/git`, no barrel
  index), `packages/client-runtime` (web/mobile shared client).
- **Vendored `.repos/`** = read-only reference — don't edit or import from it (app code
  imports from normal package deps). For Effect code read `.repos/effect-smol/LLMS.md`
  first and study `.repos/effect-smol/`; for relay/Alchemy code see `.repos/alchemy-effect/`.
  Manage subtrees via `bun run sync:repos`.
