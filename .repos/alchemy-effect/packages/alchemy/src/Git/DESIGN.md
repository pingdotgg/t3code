# git-service — Final Design Document

**A Git hosting service on Cloudflare Workers + Durable Objects + R2, built as `packages/git` with Alchemy Effect-native Workers.**

Stance: **protocol-first minimalist core (Proposal A's skeleton) with Proposal B's product ergonomics and scale seams grafted on.** v1 is the smallest system that real `git` clients (git ≥ 1.6.6 through current) can clone, fetch, and push against, with transactional refs and a typed REST management plane. Every cut has a named upgrade seam. The architecture is the ripgit/chr33s-validated shape (Worker router → one DO per repo → SQLite refs/objects + R2 overflow), re-expressed in Effect with real transactions (`transactionSync`), typed errors, streaming responses, and auth from day one.

---

## 0. Resolved contradictions (A vs B)

Every place the two proposals disagreed, with the decision and the one-line reason:

| Topic | A said | B said | **Decision** | Why (one line) |
|---|---|---|---|---|
| Object bytes at rest | zlib rows in DO SQLite, >1 MiB → R2 | Pack-first: pushed packs verbatim to R2, DO holds index only | **A** (rows + R2 overflow; packs are v1.1) | Pack emission from pre-deflated rows is pure concatenation (zero CPU), ripgit-proven in 128 MB; B's two-pass R2-fixup ingest is the single riskiest subsystem and buys nothing until repos outgrow the 50 MiB push cap — the `location`/`pack_id` columns keep B's endgame reachable without a migration. |
| Where the protocol runs | Inside the Repo DO | Worker data plane, DO control plane | **A** (in the DO) | The bytes live in the DO's SQLite so they must transit it anyway; duration billing is ~$0.0001 per clone-minute (0.125 GB × 60 s × $12.50/M GB-s), and B's Worker-side streaming becomes the natural v1.1 fast path only once compacted packs live in R2. |
| Fetch protocol | v0 only | v2 primary + v0 fallback | **A** (v0 only) | Every client ≥1.6.6 falls back to v0 silently; v2 is a pure-additive choreography file over the same closure/pack code, so shipping it in v1 doubles conformance surface for zero client reach. |
| Push ingestion | Buffer ≤ 50 MiB, `RandomAccess` seam | Stream to R2 multipart + 2-pass fixups | **A** (buffer + cap) | Bounded, simple, ripgit-proven; the parser is written against a `RandomAccess` source so the R2-tee upgrade is one implementation swap, not a protocol change. |
| Served deltas / thin packs | Never (fat packs) | Thin REF_DELTA against have-closure | **A** (never) | Thin-pack/ofs-delta serving are protocol MAYs; fat fetches are a bandwidth tax, not a correctness issue, and delta emission is the classic source of corruption bugs. |
| Name authority | Singleton Registry DO | Per-namespace NamespaceDO | **A** (singleton) with B's shard seam | Control-plane traffic is tiny in v1 and a singleton gives global listing for free; `getByName("registry:" + owner)` sharding changes no RPC interface. |
| Concurrent pushes | Unaddressed (staging ids make it safe-ish) | SQL receive lease + 503 | **Graft B, simplified**: in-memory `Effect.Semaphore` in the DO | Two 50 MiB buffers ≈ the whole isolate heap; one DO instance means an in-memory gate suffices (eviction kills the connection anyway) — no lease table needed. Waiters block ≤ 30 s, then `503 Retry-After: 10`. |
| Connectivity check on push | new-oids exist only | Full referenced-object membership | **Graft B** (full check) | With everything in SQLite the membership check is cheap batched SQL, and it's the difference between "corrupt client" and "corrupt repo". |
| Commit graph shape | `commits` + `commit_parents` tables | Single row, concatenated parents, `gen`, `commit_time` | **A's normalized tables + B's `gen`/`commit_time` columns** | Normalized parents make the BFS a JOIN; generation numbers bound negotiation walks and cost nothing at ingest. |
| Oid encoding | TEXT 40-hex | BLOB 20-byte | **A** (TEXT hex) | zdata BLOBs dominate storage, so index bytes aren't the bottleneck; hex rows are debuggable and match the wire. |
| Fork | Vague (test-plan only) | Catalog-row sharing of parent's immutable R2 keys | **Graft B's sharing, adapted**: row snapshot copy + shared R2 keys via `objects.r2_key` | SQLite rows must be copied (no cross-DO sharing), but R2 objects are immutable and shared by full key; parent's R2 prefix is retained while `fork_count > 0`. |
| Import / fork / delete execution | Unspecified | Cloudflare Queue consumer jobs | **DO alarm jobs, no Queue** | Alarms have the same 15-min budget as queue consumers, reuse the DO-resident ingest code directly, and add zero infrastructure. |
| Async-op status surface | — | `jobs` table + jobs endpoints | **Neither**: `Repo.status` field + `RepoNotReady` error | Polling `GET /repos/:o/:r` for `status: importing\|forking\|deleting → ready\|404` needs no jobs API and no cross-DO status plumbing. |
| REST ref writes | Deferred to v2 | PUT/DELETE with CAS in v1 | **Graft B** (in v1) | They reuse the exact `transactionSync` CAS path receive-pack already needs — ~50 lines for a genuinely useful surface (CI tagging, release automation). |
| Repo create response | `Repo` | `RepoCreated` with bootstrap write token + remote URL | **Graft B** | Kills the create-then-mint round trip; the token machinery exists anyway. |
| `readOnly` repos | — | Repo flag, `ReadOnlyRepo` 403 | **Graft B** | One config row + one check in receive-pack and ref-write; Artifacts parity. |
| Token scopes | read/write/admin, names, optional TTL | read/write, mandatory TTL | **A** (three scopes, names, optional TTL) | Per-repo `admin` scope enables delegated token management without handing out the deployer key; mandatory TTL is policy, not mechanism — leave it to the caller. |
| Blob REST reads | base64 JSON ≤ 1 MiB + raw streaming route | Octet-stream HttpApi endpoint + `file` path endpoint | **A's split + B's `file` route** (as a raw route) | Raw routes keep binary streaming out of schema land (repo convention); the path-walk `file` read is cheap over existing tree primitives and highly useful. |
| Error tag namespacing | Plain tags (`RepoNotFound`) | Prefixed (`git-service/RepoNotFound`) | **A** (plain) | Shorter wire payloads, matches `HttpApiError` conventions; the API name already scopes the client. |
| Repo delete semantics | Sync NoContent | Async job id | **NoContent immediately, async purge via alarm** (`status: "deleting"` until gone) | R2 prefix deletion is a list+delete loop that can't run inline; the status field already carries the async story. |

---

## 1. Decisions up front (the opinionated core)

| Decision | Choice | Why |
|---|---|---|
| Protocol version | **v0 only** (upload-pack and receive-pack) | git ≥ 2.26 sends `Git-Protocol: version=2` but falls back cleanly when the server answers v0. ripgit ships v0-only and hosts 40k-commit repos. v2 is a pure-additive upgrade (§10). |
| Negotiation | multi_ack_detailed + no-done, "lazy-ready" | Converges in ≤ 2 POSTs, stateless, answered per-POST from SQLite. |
| Served packs | **No deltas, no thin packs.** Every entry = varint header + stored zlib bytes, concatenated | Legal (thin-pack/ofs-delta are MAYs); zero-CPU pack emission because objects are stored as `zlib(content)` — pack generation is literally concatenation + SHA-1. |
| Push ingestion | Full thin-pack + ofs/ref-delta support, **pack body buffered, hard cap 50 MiB**, one push at a time per repo | Thin packs on push are non-optional (git always sends them over HTTP). Buffering with a cap is the ripgit-proven memory budget; the streaming-to-R2 upgrade is a contained change (§3.6). |
| Where the protocol runs | **Inside the Repo DO** (Worker authenticates + proxies) | The DO owns refs and all loose object bytes; single-threading + input/output gates make ref CAS trivially serializable. Duration billing is a non-issue (§0). |
| Object storage | zlib-compressed rows in DO SQLite; objects > 1 MiB compressed → R2; pack compaction to R2 is **v1.1**, schema-ready | Simplest storage that is actually transactional. The 2 MB SQLite row cap forces the R2 split; the `location` column makes compaction additive. |
| Refs | DO SQLite, CAS inside `transactionSync` | The single strongest reason this architecture works. R2 is disqualified (1 write/s/key, last-writer-wins). |
| Hashing | SHA-1 only (`object-format=sha1`) | sha256 repos are rare; oid schemas are branded so widening later is mechanical. |
| Repos | All private in v1. Anonymous = 401. `readOnly` flag rejects writes with a typed 403 | Cuts the visibility model; auth is one code path. |
| Shallow | `shallow` + `deepen <n>` (depth only) in v1 | Without it `actions/checkout` (depth=1 default) fails hard. Bounded BFS + boundary lines — cheap. `deepen-since`/`deepen-not` cut. |
| Fork / import / delete | Async DO-alarm jobs; status via `Repo.status`; forks share parent R2 keys | Reuses DO-resident ingest and purge code; zero new infrastructure; R2 immutability makes sharing safe. |
| Free Workers plan | Unsupported | 10 ms CPU cannot inflate a pack. `GitWorker` sets `limits.cpu_ms = 300_000`. |

---

## 2. Architecture

### 2.1 Components

```
                    ┌────────────────────────────────────────────────┐
 git CLI / REST     │  GitWorker (stateless, Effect-native Worker)   │
 client             │  • routes /api/v1/** → Effect HttpApi          │
   ──────────────►  │  • routes /:owner/:repo.git/** → git protocol  │
                    │  • parses Basic/Bearer creds (never verifies   │
                    │    repo tokens itself — the Repo DO does)      │
                    │  • verifies the admin key (timingSafeEqual)    │
                    │  • Registry lookups (owner/name → repoId),     │
                    │    60 s in-isolate LRU cache                   │
                    └───────┬──────────────────────────┬─────────────┘
                            │ typed RPC / stub.fetch   │ typed RPC
                            ▼                          ▼
        ┌──────────────────────────────┐   ┌────────────────────────┐
        │  Repo DO (one per repo,      │   │  Registry DO           │
        │  getByName(repoId))          │   │  (singleton,           │
        │  owns: refs, objects index,  │   │  getByName("registry"))│
        │  loose object bytes, tokens, │   │  owns: owner/name →    │
        │  commit graph, push staging, │   │  repoId map, listing,  │
        │  alarm jobs (import/fork/    │   │  uniqueness, fork      │
        │  delete-purge/GC)            │   │  lineage + counts      │
        │  runs: advertise, upload-    │   └────────────────────────┘
        │  pack, receive-pack          │
        └──────────┬───────────────────┘
                   │ R2 binding (inside the DO for oversize reads/writes)
                   ▼
        ┌──────────────────────────────┐
        │  R2 bucket "git-objects"     │
        │  {repoId}/objects/{oid}      │  oversize loose objects (immutable)
        │  {repoId}/packs/pack-*.pack  │  v1.1 compaction output (immutable)
        └──────────────────────────────┘
```

**Why one DO per repo (not a namespace DO holding many):** per-repo write serialization for free (ref CAS needs no locks), per-repo isolation of the 10 GB SQLite ceiling, horizontal scale by construction. The DO id is `idFromName(repoId)` where `repoId` is a ULID minted at creation — **not** `owner/name` — so renames never move data and a deleted-then-recreated `owner/name` gets a fresh DO (no zombie state).

**Why a singleton Registry DO:** repo CRUD needs a uniqueness authority, a listing surface, and a fork-lineage ledger. It's low-rate control-plane traffic. Upgrade seam: shard by owner via `getByName("registry:" + owner)` — the RPC interface doesn't change; global listing then requires fan-out or is cut. The Worker caches `owner/name → repoId` per-isolate for 60 s; the Repo DO stores its own `(owner, name)` and rejects mismatched requests, so a stale cache entry fails safe and triggers re-resolve.

**Why the git protocol runs in the DO, not the Worker:** every byte the protocol needs (refs, object rows, commit graph, tokens) lives in the DO's SQLite. Running upload/receive-pack in the Worker would mean chatty RPC choreography for thin-base lookups, staging batches, and manifest paging. Inside the DO it's direct synchronous SQL. Long pushes don't starve reads: workerd interleaves other events at non-storage `await` points (client body reads, R2 calls), and the ref CAS at the end is a single `transactionSync`. The one inherited rule: **re-verify nothing across an `await` — all ref reads/writes happen inside the final `transactionSync`.**

**Push serialization:** the Repo DO's runtime closure holds an `Effect.Semaphore(1)` guarding receive-pack ingest (two concurrent 50 MiB buffers would exhaust the 128 MB isolate). A second push waits up to 30 s for the permit, then gets `503` + `Retry-After: 10` (git retries cleanly). In-memory is sufficient: there is exactly one live instance per DO, and an eviction mid-push kills the holder's connection anyway.

### 2.2 URL space

```
/api/v1/**                              REST (Effect HttpApi)
/api/v1/repos/:o/:r/blobs/:oid/raw      raw blob bytes (raw route, streaming)
/api/v1/repos/:o/:r/file?ref&path       file-at-path bytes (raw route, streaming)
/:owner/:repo[.git]/info/refs           smart-HTTP ref advertisement
/:owner/:repo[.git]/git-upload-pack     fetch/clone
/:owner/:repo[.git]/git-receive-pack    push
```

`api` is a reserved owner name (Registry rejects it at creation). The Worker's `fetch` is the canonical `StateStore/Api.ts` composition: `HttpApiBuilder.layer(GitApi)` + handler layers + `Layer.merge(rawGitRoutes)` (raw routes registered on the same `HttpRouter`) + `[Etag.layer, HttpPlatformStub, Path.layer]` + `HttpRouter.toHttpEffect` (§5, §6).

### 2.3 Request flows

**Clone (fresh):**
1. `GET /:o/:r.git/info/refs?service=git-upload-pack` → Worker parses Basic creds, Registry lookup (cached) → `repos.getByName(repoId).fetch(request)` → DO verifies token (read scope), rejects with `RepoNotReady` semantics (503) while `status != ready`, then emits the v0 advertisement: `# service=` prelude, flush, `HEAD` first with capability line (`multi_ack_detailed no-done side-band-64k shallow ofs-delta agent=git-service/1 symref=HEAD:refs/heads/<default> object-format=sha1`), refs sorted, annotated tags peeled (`^{}` lines), flush. `Cache-Control: no-cache`. Empty repo: zero-id `capabilities^{}` line.
2. `POST git-upload-pack` — body is `want`s + flush + `done` (no haves). DO gunzips if `Content-Encoding: gzip` (`DecompressionStream("gzip")`; sniff `1f 8b` defensively), parses pkt-lines, computes the full closure (§3.5), replies `NAK` then the pack on sideband band 1 (65515-byte frames), progress on band 2, flush. If the client did **not** negotiate `side-band-64k`, the pack is sent raw after the ACK/NAK section. The response body is a `Stream<Uint8Array>` — `HttpServerResponse.stream(...)`, chunked, flushed as written; the Worker proxies the `HttpServerResponse` from `stub.fetch` untouched.

**Incremental fetch:** same, but the POST carries `have`s. Round 1 (ends in flush): DO `ACK <oid> common` for each have that exists in `objects`, `ACK <oid> ready` once the want-closure is coverable, else `NAK`. With `no-done` the DO may continue straight into the pack after `ready`. Round 2 (ends in `done`): final `ACK`/`NAK` + pack. Closure = commits BFS from wants stopping at ACKed haves (generation numbers bound the walk), plus those commits' full tree/blob closure with an in-walk visited set (§3.5 — the accepted v1 fat: ~one snapshot's worth of redundancy at the boundary; harmless to clients).

**Shallow clone (`--depth N`):** wants + `deepen N`. DO does a depth-bounded BFS, emits `shallow <oid>` boundary lines (and `unshallow` for previously-shallow client tips now complete), flush, then ACK/NAK + depth-truncated pack. Client `shallow` lines on later fetches are treated as additional walk boundaries.

**Push:**
1. `GET info/refs?service=git-receive-pack` → v0 advertisement with `report-status report-status-v2 delete-refs side-band-64k atomic ofs-delta object-format=sha1 agent=git-service/1`.
2. `POST git-receive-pack` → DO: acquire the push semaphore; parse command pkt-lines (`old new refname\0caps` on the first); handle the **empty-flush probe** (git sends a bare `0000` POST when the payload exceeds `http.postBuffer`; reply empty 200 so it retries with the real body). Reject writes to `readOnly` repos with `ng` per ref. Buffer the raw pack (reject > 50 MiB with `unpack pack exceeds 50 MiB limit` + per-ref `ng` — a clean in-band report, not an HTTP error). Ingest (§3.6): index → resolve deltas (thin bases from own store) → hash → stage → **connectivity check** (every oid referenced by staged commits/trees is in staged ∪ live objects; batched SQL). Then one `transactionSync`: CAS every command's old-oid against `refs`, honor `atomic` (all-or-nothing) vs per-ref, flip staged objects live, insert commit-graph rows, update `default_branch` on first branch push. Reply `report-status` (`unpack ok` / `ok|ng <ref>`) **wrapped in sideband band 1** when the client negotiated side-band (unmuxed report while sideband is active breaks the client). `report-status-v2` is advertised and implemented identically (no `option` lines — valid).
3. Post-commit, `state.waitUntil`: GC bookkeeping, compaction-threshold check (v1.1 alarm).

**Fork:** `POST /repos/:o/:r/fork` → Registry CAS-inserts the target row (`status: "forking"`, `fork_of`, bump parent `fork_count`) → new Repo DO initializes and arms an immediate alarm → alarm job streams a row snapshot from the parent DO over an RPC `Stream` (refs, objects metadata **including `zdata` for `location='row'` rows**, commits, config) and copies it in batches; `location='r2'` rows are copied **by reference** — the `r2_key` column carries the parent's full key (immutable, shared) → `status: "ready"`. Documented v1 limit: fork cost is O(parent row bytes); v1.1 compaction (bytes in shared R2 packs) makes forks near-O(index).

**Import:** `POST /repos/import` → Registry inserts (`status: "importing"`) → Repo DO alarm job acts as a git v0/v2 HTTP client against the source URL (depth-limited fetch), ingests through the same `PackParser` path with the same 50 MiB cap (documented v1 limit: small/depth-limited imports only), sets refs, `status: "ready"`; failures set `status` back plus an error detail readable on the Repo resource.

**Delete:** `DELETE /repos/:o/:r` → Registry marks `deleted_at` (name freed for reuse only after purge), Repo `status: "deleting"` → NoContent immediately → alarm job purges: R2 prefix list+delete loop (bounded per alarm run, re-armed until done) — **but the R2 prefix is retained while Registry reports `fork_count > 0`** (forks reference those keys); SQLite dropped via `deleteAll`; Registry row removed last. Purge is idempotent and alarm-retried.

**REST call:** `POST /api/v1/repos/:o/:r/tokens` → HttpApi middleware parses credentials into a `Credentials` service → handler calls `repos.getByName(repoId).createToken(credentials, {...})` → DO enforces scope and returns; tagged errors surface as typed HTTP statuses.

---

## 3. Storage design

### 3.1 Repo DO SQLite schema (exact DDL)

```sql
-- config: repoId, owner, name, default_branch, description, created_at,
--         schema_version, status ('ready'|'importing'|'forking'|'deleting'),
--         read_only ('0'|'1'), fork_of (parent repoId or absent)
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- all refs, full names. HEAD is virtual: symref to config.default_branch.
CREATE TABLE IF NOT EXISTS refs (
  name TEXT PRIMARY KEY,          -- 'refs/heads/main', 'refs/tags/v1'
  oid  TEXT NOT NULL              -- 40-hex sha1
) WITHOUT ROWID;

-- object index + loose bytes. zdata is zlib(content) WITHOUT the loose header,
-- so pack emission is: varint(type,size) + zdata, verbatim.
CREATE TABLE IF NOT EXISTS objects (
  oid         TEXT PRIMARY KEY,   -- 40-hex
  type        INTEGER NOT NULL,   -- 1=commit 2=tree 3=blob 4=tag
  size        INTEGER NOT NULL,   -- uncompressed bytes
  zsize       INTEGER NOT NULL,   -- stored/compressed bytes
  location    TEXT NOT NULL DEFAULT 'row',  -- 'row' | 'r2' | 'pack' (pack = v1.1)
  zdata       BLOB,               -- NULL when location != 'row'
  r2_key      TEXT,               -- full R2 key when location='r2'; may point at a
                                  -- FORK PARENT's prefix (immutable, shared)
  pack_id     TEXT,               -- v1.1: packs/pack-<sha>.pack
  pack_offset INTEGER,            -- v1.1: byte offset of zdata within pack
  staged_push TEXT                -- NULL = live; else the push_id that staged it
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_objects_staged ON objects(staged_push) WHERE staged_push IS NOT NULL;

-- commit graph for closure/negotiation walks (populated at ingest)
CREATE TABLE IF NOT EXISTS commits (
  oid         TEXT PRIMARY KEY,
  tree        TEXT NOT NULL,
  gen         INTEGER NOT NULL,   -- generation number: max(parent gen) + 1; roots = 1
  commit_time INTEGER NOT NULL    -- committer timestamp (seam: deepen-since)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS commit_parents (
  oid    TEXT NOT NULL,
  parent TEXT NOT NULL,
  ord    INTEGER NOT NULL,
  PRIMARY KEY (oid, parent)
) WITHOUT ROWID;

-- per-repo access tokens (§8)
CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,        -- ULID
  token_hash   TEXT NOT NULL UNIQUE,    -- hex(sha256(token))
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL,           -- 'read' | 'write' | 'admin'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,                 -- NULL = no expiry
  last_used_at INTEGER
) WITHOUT ROWID;

-- crash-safety bookkeeping for pushes (GC'd by alarm)
CREATE TABLE IF NOT EXISTS pushes (
  push_id    TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  state      TEXT NOT NULL              -- 'staging' | 'committed'
) WITHOUT ROWID;

-- async job bookkeeping (import/fork/delete-purge progress; single row per kind)
CREATE TABLE IF NOT EXISTS jobs (
  kind       TEXT PRIMARY KEY,          -- 'import' | 'fork' | 'purge' | 'gc'
  state      TEXT NOT NULL,             -- 'running' | 'failed'
  detail     TEXT,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

Registry DO:

```sql
CREATE TABLE IF NOT EXISTS repos (
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  repo_id     TEXT NOT NULL UNIQUE,     -- ULID
  description TEXT,
  fork_of     TEXT,                     -- parent repo_id, NULL if not a fork
  fork_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER,                  -- soft-delete marker during purge
  PRIMARY KEY (owner, name)
) WITHOUT ROWID;
```

Schema init runs in the DO's outer init effect under `blockConcurrencyWhile` semantics (idempotent `CREATE TABLE IF NOT EXISTS`), with a `schema_version` config row for future migrations. Note the platform gotcha: DO RPC methods must not be named `delete` (Cloudflare stub proxy reserves it) — use `remove`/`purge`.

### 3.2 R2 key scheme

```
{repoId}/objects/{oid}            zlib(content), immutable, written once
{repoId}/packs/pack-{sha1}.pack   v1.1 compaction output, immutable
```

All R2 keys are **immutable and content-addressed** — this sidesteps the 1-write/s/key limit, makes conditional-put re-runs (idempotent alarm jobs) safe, and makes **cross-repo fork references safe** (a fork's `objects.r2_key` may point into the parent's prefix). R2 `list()` is never used on a hot path (Class A, $4.50/M); the `objects` table is the sole inventory. List is used only in delete-purge and GC reconciliation.

### 3.3 Loose vs. R2 thresholds and the promotion story

- **`location='row'`**: compressed size ≤ **1 MiB** (safety margin under the 2 MB SQLite row cap). This is where every normal object lives in v1. Read cost: DO rows at $0.001/M, synchronous, no 6-connection cap — 360× cheaper and far faster than per-object R2 GETs.
- **`location='r2'`**: compressed size > 1 MiB → written to `{repoId}/objects/{oid}` at ingest (single streaming `put`), row records metadata + `r2_key`.
- **Per-object cap (v1): 64 MiB uncompressed.** Delta application needs base + result in memory; this cap keeps worst-case ingest memory bounded. Rejected with `unpack object too large` + `ng`.
- **Promotion/compaction (v1.1, schema-ready, not in v1):** an alarm fires when `SUM(zsize) WHERE location='row'` > **1 GB** or live loose count > **50 000**. The handler streams a no-delta pack of the oldest N objects to R2 via multipart (5 MiB uniform parts), then in one `transactionSync` flips those rows to `location='pack'` with `pack_id`/`pack_offset` and NULLs `zdata`. Because pack entries are `varint header + zlib(content)` and we store `zlib(content)`, the "pack" is a concatenation — and `pack_offset` points at the zdata span, so fetch does **ranged R2 reads** per object, or (B's fast path, adopted as the v1.1 clone path) streams whole entry-regions verbatim for full clones. Idempotent (content-addressed pack key + conditional put), alarm-retried, 15-min budget respected by capping objects per run. Nothing in the fetch path changes shape: the emitter already dispatches on `location`.

This ordering (row → r2/pack) is forced by the platform numbers: DO storage $0.20/GB-mo vs R2 $0.015 (13×) makes R2 the long-term home; DO rows' read economics make them the right hot tier; the 2 MB row cap draws the line.

### 3.4 Transactionality of ref updates

All ref mutations — push commands, REST ref writes, fork/import finalization — go through one code path in the Repo DO:

```ts
// inside receive-pack finalize, single event, no awaits inside:
storage.transactionSync(() => {
  for (const cmd of commands) {
    const current = sql.exec("SELECT oid FROM refs WHERE name = ?", cmd.ref).one()?.oid ?? ZERO;
    if (current !== cmd.oldOid) { results.push(ng(cmd.ref, "fetch first")); if (atomic) throw new RefCasFailed(results); continue; }
    // delete / insert / update refs row
  }
  sql.exec("UPDATE objects SET staged_push = NULL WHERE staged_push = ?", pushId);
  // insert commits / commit_parents rows for staged commits
  sql.exec("UPDATE pushes SET state = 'committed' WHERE push_id = ?", pushId);
});
```

The DO's input/output gates guarantee no interleaving between statements; `transactionSync` guarantees atomicity against mid-event failure. The client's `old-oid` is the compare-and-swap token (this also makes force-push semantics correct without locking). REST `PUT/DELETE` ref endpoints run the same block with a single synthetic command (`expectedOid` → old-oid; absent `expectedOid` = unconditional). Crash before the transaction ⇒ staged rows with a dangling `push_id`; a daily alarm deletes `pushes` rows in `staging` older than 24 h and their staged objects (R2 orphans under `objects/` are harmless — content-addressed — and re-pushed identical objects hit the same key).

### 3.5 Fetch closure computation and pack assembly within 128 MB

**Closure:** BFS from wants over `commit_parents` (in-DO SQL, chunked `IN` lists ≤ 100 params), stopping at haves that exist in `objects`, bounded below by generation numbers (never walk past `min(gen(haves))` unnecessarily), and at the depth bound when `deepen` is present. Then walk each frontier commit's tree: read tree rows, parse entries, recurse, with an in-memory visited `Set<string>` shared across the whole walk. Memory: 500 k oids ≈ 25 MB of Set — cap manifest at 1 M objects for v1 (larger repos are a documented v1 limit; the v1.1 fix is whole-pack streaming from R2 for clones).

**Emission (all streaming, constant memory):**

```
PACK + version(2) + count(manifest.length)          — count known before streaming: manifest is materialized first
for each oid in manifest (batched row reads, ≤100/query, ~8 MiB adaptive zsize budget):
    emit varint(type, size) + zdata                  — 'row': the BLOB; 'r2': R2 get body; 'pack' (v1.1): R2 ranged get
    sha1.update(everything)                          — node:crypto createHash, incremental
emit sha1 trailer
```

Wrapped in a sideband-band-1 framing transform (≤ 65515-byte payloads) when negotiated, returned as `HttpServerResponse.stream`. No compression CPU at all — bytes are stored pre-deflated. Progress lines (`Counting objects...`) on band 2 every N objects.

### 3.6 Push ingest within 128 MB

Single pass over the buffered pack (≤ 50 MiB), under the push semaphore:

1. Validate `PACK`, version 2, count.
2. Per entry: parse type/size varint. Non-delta: `zlib.createInflate()`, feed the tail; on `end`, `bytesWritten` = exact compressed span (workerd-verified). Hash `sha1("<type> <size>\0" + content)`. **Store the compressed span verbatim as `zdata`** — no recompression. Deltas (OFS with the +1-bias offset decoding, REF with 20-byte base id): resolve base from (a) already-ingested entries via a bounded LRU of resolved contents (20 MiB, shared buffers), (b) re-inflation from the pack buffer on cache miss, or (c) **the object store for thin bases** (REF_DELTA to a prior push — the normal case). Apply the copy/insert instruction stream (`size==0 ⇒ 0x10000` special case), verify `result_size`, hash, `deflateSync` (level 6), store.
3. Verify the trailing pack SHA-1; mismatch ⇒ `unpack pack checksum mismatch` + all-`ng`.
4. Rows inserted with `staged_push = pushId` as resolved (objects > 1 MiB compressed go to R2 first, then the row). Existing oids skipped (idempotent re-push).
5. **Connectivity check (full):** collect every oid referenced by staged commits (tree, parents) and staged trees (entries), and every command's `new-oid`; batched `SELECT` membership against staged ∪ live objects (chunked `IN` ≤ 100). Any miss ⇒ `unpack missing objects` + all-`ng`. Cheap SQL; prevents a buggy/malicious client from corrupting the repo.
6. Compute `gen`/`commit_time` for staged commits (parents are all present per step 5).

Budget: 50 MiB pack + 20 MiB cache + ≤ 64 MiB single-object worst case is theoretical-max-tight; in practice large objects aren't delta'd against large bases, and ripgit ships this exact profile in 128 MB. The semaphore guarantees one ingest at a time. The pack size cap is enforced *before* buffering via `Content-Length` when present and by counting during body read otherwise.

**Upgrade seam (v1.x, when the 50 MiB cap hurts):** tee the incoming body to R2 multipart (`{repoId}/incoming/{pushId}.pack`) while indexing in the same pass; delta re-resolution then uses R2 ranged reads instead of the memory buffer. The parser is written against a `RandomAccess` abstraction (`PackParser.ingest(source: RandomAccess)`) from day one so this swap touches one implementation, not the protocol code.

---

## 4. Git protocol scope for v1

### Supported (exact)

| Area | v1 support |
|---|---|
| Transport | Smart HTTP only. `info/refs` advertisement with `# service=` prelude for both services; `Cache-Control: no-cache`; 401 + `WWW-Authenticate: Basic realm="git-service"`; gzip request bodies decompressed (`DecompressionStream("gzip")` + `1f 8b` sniff); streamed chunked responses; `ERR` pkt / band-3 for in-band fatals; 503 + `Retry-After` on push contention. |
| upload-pack (fetch/clone) | **Protocol v0.** Capabilities: `multi_ack_detailed`, `no-done`, `side-band-64k`, `shallow` (+ `deepen <n>` only), `agent`, `symref=HEAD:...`, `object-format=sha1`. Peeled `^{}` lines for annotated tags. Negotiation: ack `common` for known haves, `ready` when coverable, else `NAK`; ≤ 2 rounds. Empty-repo advertisement (`capabilities^{}`). Non-sideband clients get the raw pack. |
| receive-pack (push) | Protocol v0 (push has no v2). Capabilities: `report-status`, `report-status-v2`, `delete-refs`, `side-band-64k`, `atomic`, `ofs-delta`, `object-format=sha1`, `agent`. Create/update/delete refs, old-oid CAS, force push (unpoliced in v1), thin-pack + ofs/ref-delta ingestion, full connectivity check, empty-flush probe handling, report inside band 1, one-push-at-a-time serialization. |
| Objects | commit, tree, blob, **tag (annotated tags stored and served — not dropped)**. Byte-verbatim round-tripping (we never re-serialize; hashes, gpgsig, timezones survive — automatic, since stored bytes are the received bytes). |

The cut list with upgrade paths is consolidated in §10.

---

## 5. The Effect HttpApi REST surface

Contract lives in `src/Api.ts`, following `packages/alchemy/src/Cloudflare/StateStore/Api.ts` / `State/HttpStateApi.ts` conventions (effect `4.0.0-beta.105`, `effect/unstable/httpapi`). Abbreviated only where repetitive:

```ts
import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

// ── primitives ────────────────────────────────────────────────────────────
export const Oid = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/), Schema.brand("Oid"));
export const RepoName = Schema.String.pipe(Schema.pattern(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/i));
export const OwnerName = RepoName;
export const RefName = Schema.String.pipe(Schema.pattern(/^refs\/[^\s~^:?*\[\\]+$/));
export const TokenScope = Schema.Literals(["read", "write", "admin"]);
export const RepoStatus = Schema.Literals(["ready", "importing", "forking", "deleting"]);

// ── error taxonomy (tagged, status-annotated) ─────────────────────────────
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()("Unauthorized",
  {}, HttpApiSchema.annotations({ status: 401 })) {}
export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()("Forbidden",
  { required: TokenScope }, HttpApiSchema.annotations({ status: 403 })) {}
export class ReadOnlyRepo extends Schema.TaggedErrorClass<ReadOnlyRepo>()("ReadOnlyRepo",
  {}, HttpApiSchema.annotations({ status: 403 })) {}
export class RepoNotFound extends Schema.TaggedErrorClass<RepoNotFound>()("RepoNotFound",
  { owner: Schema.String, repo: Schema.String }, HttpApiSchema.annotations({ status: 404 })) {}
export class RepoAlreadyExists extends Schema.TaggedErrorClass<RepoAlreadyExists>()("RepoAlreadyExists",
  { owner: Schema.String, repo: Schema.String }, HttpApiSchema.annotations({ status: 409 })) {}
export class RepoNotReady extends Schema.TaggedErrorClass<RepoNotReady>()("RepoNotReady",
  { status: RepoStatus }, HttpApiSchema.annotations({ status: 409 })) {}
export class RefNotFound extends Schema.TaggedErrorClass<RefNotFound>()("RefNotFound",
  { ref: Schema.String }, HttpApiSchema.annotations({ status: 404 })) {}
export class RefConflict extends Schema.TaggedErrorClass<RefConflict>()("RefConflict",
  { ref: Schema.String, currentOid: Schema.NullOr(Oid) }, HttpApiSchema.annotations({ status: 409 })) {}
export class ObjectNotFound extends Schema.TaggedErrorClass<ObjectNotFound>()("ObjectNotFound",
  { oid: Schema.String }, HttpApiSchema.annotations({ status: 404 })) {}
export class WrongObjectType extends Schema.TaggedErrorClass<WrongObjectType>()("WrongObjectType",
  { oid: Schema.String, expected: Schema.String, actual: Schema.String },
  HttpApiSchema.annotations({ status: 422 })) {}
export class ObjectTooLarge extends Schema.TaggedErrorClass<ObjectTooLarge>()("ObjectTooLarge",
  { oid: Schema.String, size: Schema.Number }, HttpApiSchema.annotations({ status: 422 })) {}
export class TokenNotFound extends Schema.TaggedErrorClass<TokenNotFound>()("TokenNotFound",
  { id: Schema.String }, HttpApiSchema.annotations({ status: 404 })) {}
export class ImportFailed extends Schema.TaggedErrorClass<ImportFailed>()("ImportFailed",
  { reason: Schema.String }, HttpApiSchema.annotations({ status: 502 })) {}
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError",
  { message: Schema.String }, HttpApiSchema.annotations({ status: 400 })) {}

// ── auth middleware ───────────────────────────────────────────────────────
// Parses Basic (git CLI: password = token) or Bearer into a Credentials service.
// Enforcement happens in the Repo DO, which owns the tokens table (§8).
export class Credentials extends Context.Service<Credentials, {
  readonly token: Redacted.Redacted<string>;      // repo token or admin key
}>()("git-service/Credentials") {}

export class GitAuth extends HttpApiMiddleware.Service<GitAuth, { provides: Credentials }>()(
  "git-service/GitAuth",
  { security: { bearer: HttpApiSecurity.bearer, basic: HttpApiSecurity.basic },
    error: Unauthorized },
) {}

// ── domain shapes ─────────────────────────────────────────────────────────
export class Repo extends Schema.Class<Repo>("Repo")({
  owner: OwnerName, name: RepoName, repoId: Schema.String,
  defaultBranch: Schema.String, description: Schema.NullOr(Schema.String),
  readOnly: Schema.Boolean,
  forkOf: Schema.NullOr(Schema.String),            // parent repoId
  status: RepoStatus,                              // poll this for async fork/import/delete
  createdAt: Schema.Number,
}) {}
export class Ref extends Schema.Class<Ref>("Ref")({
  name: RefName, oid: Oid, peeled: Schema.optional(Oid),
}) {}
const Signature = Schema.Struct({
  name: Schema.String, email: Schema.String, date: Schema.Number, tz: Schema.String });
export class CommitInfo extends Schema.Class<CommitInfo>("CommitInfo")({
  oid: Oid, tree: Oid, parents: Schema.Array(Oid),
  author: Signature, committer: Signature, message: Schema.String,
}) {}
export class TreeEntry extends Schema.Class<TreeEntry>("TreeEntry")({
  mode: Schema.String, name: Schema.String, oid: Oid,
  type: Schema.Literals(["blob", "tree", "commit"]),   // commit = gitlink
}) {}
export class TokenInfo extends Schema.Class<TokenInfo>("TokenInfo")({
  id: Schema.String, name: Schema.String, scope: TokenScope,
  createdAt: Schema.Number, expiresAt: Schema.NullOr(Schema.Number),
  lastUsedAt: Schema.NullOr(Schema.Number),
}) {}
export class CreatedToken extends TokenInfo.extend<CreatedToken>("CreatedToken")({
  token: Schema.String,                                 // shown exactly once
}) {}
export class RepoCreated extends Schema.Class<RepoCreated>("RepoCreated")({
  repo: Repo,
  remote: Schema.String,                                // https clone URL
  token: CreatedToken,                                  // bootstrap 'write' token, one round trip
}) {}
const Paginated = <A extends Schema.Top>(items: A) => Schema.Struct({
  items: Schema.Array(items), nextCursor: Schema.NullOr(Schema.String), hasMore: Schema.Boolean,
});

// ── groups ────────────────────────────────────────────────────────────────
const RepoPath = Schema.Struct({ owner: OwnerName, repo: RepoName });

const repos = HttpApiGroup.make("repos")
  .add(HttpApiEndpoint.post("create", "/repos", {
    payload: Schema.Struct({
      owner: OwnerName, name: RepoName,
      defaultBranch: Schema.optional(Schema.String),    // default "main"
      description: Schema.optional(Schema.String),
      readOnly: Schema.optional(Schema.Boolean),
    }),
    success: RepoCreated,
    error: [RepoAlreadyExists, ValidationError, Forbidden],
  }))
  .add(HttpApiEndpoint.get("get", "/repos/:owner/:repo", {
    params: RepoPath, success: Repo, error: RepoNotFound,
  }))
  .add(HttpApiEndpoint.patch("update", "/repos/:owner/:repo", {
    params: RepoPath,
    payload: Schema.Struct({
      description: Schema.optional(Schema.NullOr(Schema.String)),
      defaultBranch: Schema.optional(Schema.String),    // must resolve to an existing branch
      readOnly: Schema.optional(Schema.Boolean),
    }),
    success: Repo,
    error: [RepoNotFound, RefNotFound, Forbidden],
  }))
  .add(HttpApiEndpoint.get("list", "/repos", {
    query: Schema.Struct({
      owner: Schema.optional(OwnerName),
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))),
    }),
    success: Paginated(Repo),
  }))
  .add(HttpApiEndpoint.del("delete", "/repos/:owner/:repo", {
    params: RepoPath, success: HttpApiSchema.NoContent,   // async purge; status → 'deleting' → 404
    error: [RepoNotFound, Forbidden],
  }))
  .add(HttpApiEndpoint.post("fork", "/repos/:owner/:repo/fork", {
    params: RepoPath,
    payload: Schema.Struct({ targetOwner: OwnerName, targetName: RepoName }),
    success: RepoCreated,                                 // status: 'forking'; poll GET repo
    error: [RepoNotFound, RepoAlreadyExists, RepoNotReady, Forbidden],
  }))
  .add(HttpApiEndpoint.post("import", "/repos/import", {
    payload: Schema.Struct({
      owner: OwnerName, name: RepoName,
      source: Schema.Struct({
        url: Schema.String,
        ref: Schema.optional(Schema.String),
        depth: Schema.optional(Schema.Int.pipe(Schema.greaterThan(0))),
      }),
    }),
    success: RepoCreated,                                 // status: 'importing'; poll GET repo
    error: [RepoAlreadyExists, ImportFailed, Forbidden],
  }))
  .middleware(GitAuth);

const refs = HttpApiGroup.make("refs")
  .add(HttpApiEndpoint.get("list", "/repos/:owner/:repo/refs", {
    params: RepoPath,
    query: Schema.Struct({ prefix: Schema.optional(Schema.String) }),  // e.g. "refs/heads/"
    success: Schema.Struct({ head: Schema.NullOr(Schema.String), refs: Schema.Array(Ref) }),
    error: RepoNotFound,
  }))
  .add(HttpApiEndpoint.get("get", "/repos/:owner/:repo/ref", {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),           // query, not path — refnames contain '/'
    success: Ref,
    error: [RepoNotFound, RefNotFound],
  }))
  .add(HttpApiEndpoint.put("update", "/repos/:owner/:repo/ref", {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),
    payload: Schema.Struct({
      newOid: Oid,
      expectedOid: Schema.optional(Schema.NullOr(Oid)),  // null = must-not-exist; absent = unconditional
    }),
    success: Ref,
    error: [RepoNotFound, RefConflict, ObjectNotFound, ReadOnlyRepo, Forbidden],
  }))
  .add(HttpApiEndpoint.del("remove", "/repos/:owner/:repo/ref", {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),
    payload: Schema.Struct({ expectedOid: Schema.optional(Oid) }),
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound, RefNotFound, RefConflict, ReadOnlyRepo, Forbidden],
  }))
  .middleware(GitAuth);

const objects = HttpApiGroup.make("objects")
  .add(HttpApiEndpoint.get("commit", "/repos/:owner/:repo/commits/:oid", {
    params: RepoPath.pipe(Schema.extend(Schema.Struct({ oid: Oid }))),
    success: CommitInfo,
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  }))
  .add(HttpApiEndpoint.get("log", "/repos/:owner/:repo/log", {
    params: RepoPath,
    query: Schema.Struct({
      ref: Schema.optional(Schema.String),             // refname or oid; default HEAD
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))),
    }),
    success: Paginated(CommitInfo),
    error: [RepoNotFound, RefNotFound],
  }))
  .add(HttpApiEndpoint.get("tree", "/repos/:owner/:repo/trees/:oid", {
    params: RepoPath.pipe(Schema.extend(Schema.Struct({ oid: Oid }))),
    success: Schema.Struct({ oid: Oid, entries: Schema.Array(TreeEntry) }),
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  }))
  .add(HttpApiEndpoint.get("blob", "/repos/:owner/:repo/blobs/:oid", {
    params: RepoPath.pipe(Schema.extend(Schema.Struct({ oid: Oid }))),
    success: Schema.Struct({
      oid: Oid, size: Schema.Number,
      encoding: Schema.Literals(["base64"]), content: Schema.String,  // ≤ 1 MiB only
    }),
    error: [RepoNotFound, ObjectNotFound, WrongObjectType, ObjectTooLarge],  // 422 → use /raw
  }))
  // Raw streaming reads are registered as RAW HttpRouter routes (octet-stream),
  // outside HttpApi schema-land by design (same policy as the git wire endpoints):
  //   GET /api/v1/repos/:owner/:repo/blobs/:oid/raw
  //   GET /api/v1/repos/:owner/:repo/file?ref=<refname|oid>&path=<path>   (tree-walk per segment)
  .middleware(GitAuth);

const tokens = HttpApiGroup.make("tokens")
  .add(HttpApiEndpoint.post("create", "/repos/:owner/:repo/tokens", {
    params: RepoPath,
    payload: Schema.Struct({
      name: Schema.String, scope: TokenScope,
      ttlSeconds: Schema.optional(Schema.Int.pipe(Schema.greaterThan(0))),
    }),
    success: CreatedToken,
    error: [RepoNotFound, Forbidden],
  }))
  .add(HttpApiEndpoint.get("list", "/repos/:owner/:repo/tokens", {
    params: RepoPath, success: Schema.Array(TokenInfo), error: [RepoNotFound, Forbidden],
  }))
  .add(HttpApiEndpoint.del("revoke", "/repos/:owner/:repo/tokens/:id", {
    params: RepoPath.pipe(Schema.extend(Schema.Struct({ id: Schema.String }))),
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound, TokenNotFound, Forbidden],
  }))
  .middleware(GitAuth);

export const GitApi = HttpApi.make("git-service")
  .add(repos).add(refs).add(objects).add(tokens)
  .prefix("/api/v1");
```

**Authorization matrix** (enforced in the Repo DO, §8): admin key → everything; repo `admin` token → its repo's write + token create/list/revoke + repo update/delete; `write` → its repo's reads + receive-pack + ref writes; `read` → its repo's reads + upload-pack only. Repo create/list-all/fork/import are admin-key-only.

`GitAuthLive` follows `StateAuthLive` exactly: `Layer.effect(GitAuth, ...)` returning `{ bearer, basic }` handlers that wrap the endpoint effect with a `Credentials` provision (Basic: password field is the token, username ignored). Handlers pass `Credentials` to Repo-DO RPCs, which are the enforcement point. Mounting uses the canonical composition — `HttpApiBuilder.layer(GitApi)` + group handler layers + `GitAuthLive` + `[Etag.layer, HttpPlatformStub, Path.layer]` (the `HttpPlatform` stub copied verbatim from `StateStore/Api.ts:333`) + `Layer.merge(rawApi)` + `HttpRouter.toHttpEffect` assigned to `fetch`.

---

## 6. Package layout — `packages/git`

Shape: **library-with-deployable-stack**, modeled on `packages/better-auth` — exports Worker/DO classes + the HttpApi contract for users to compose into their own Stacks, plus a canonical Stack factory and an example app.

```
packages/git/
  package.json                # @alchemy.run/git; exports ".", "./*" (types/bun/worker→src, import→lib);
                              # peerDeps: alchemy workspace:*, effect catalog:, @cloudflare/workers-types catalog:;
                              # devDeps: alchemy-test workspace:*, isomorphic-git (test-only wire client)
  tsconfig.json               # composite, extends ../../tsconfig.base.json, refs ../alchemy, paths @/* → src/*
  tsconfig.test.json
  src/
    index.ts                  # barrel: Api contract, error classes, GitWorker, Repo, Registry, GitService
    Api.ts                    # §5 verbatim — HttpApi contract + schemas + tagged errors + GitAuth tag
    Auth.ts                   # Credentials service, GitAuthLive, credential parsing (Basic/Bearer),
                              # admin-key timing-safe compare (crypto.subtle.timingSafeEqual)
    GitWorker.ts              # class GitWorker extends Cloudflare.Worker<GitWorker>()(...):
                              #   HttpApi mount, raw routes (git wire, /blobs/:oid/raw, /file),
                              #   Registry LRU cache, stub.fetch proxying, nodejs_compat + limits.cpu_ms
    RepoObject.ts             # class Repo extends Cloudflare.DurableObject<Repo>()("GitRepo") {} + Repo.make(impl):
                              #   RPC surface (verifyToken, createToken, listTokens, revokeToken,
                              #   getRepoMeta, updateRepoMeta, listRefs, getRef, updateRef, removeRef,
                              #   readObject, readCommitLog, readFileAtPath, snapshotRows (Stream),
                              #   startImport, startFork, startPurge)
                              #   + fetch (git wire choreography) + alarm (jobs: import/fork/purge/gc)
                              #   + in-memory push Semaphore
    RegistryObject.ts         # class Registry DO: createRepo, resolve, list, forkLineage,
                              #   bumpForkCount, markDeleted, remove
    Service.ts                # GitService(options?): a function returning an Effect the user
                              #   yields inside their OWN Alchemy.Stack; deploys GitWorker (+ DOs + R2
                              #   transitively) and returns { worker, url }. No Stack is shipped.
    git/                      # pure protocol/codec modules — no DO/R2 imports, unit-testable
      Pkt.ts                  # pkt-line read/write, flush/delim, ERR pkt; Stream transforms
      Sideband.ts             # band-1/2/3 framing transform (65515 cap)
      ObjectCodec.ts          # oid hashing (node:crypto sha1, incremental), loose header,
                              # commit/tree/tag parse + tree entry sort rules, varints
      Delta.ts                # copy/insert delta application, size verification
      PackParser.ts           # §3.6 ingest over a RandomAccess source; node:zlib Inflate.bytesWritten
      PackWriter.ts           # §3.5 no-delta emitter: header/count, varint+zdata concat, sha1 trailer
      Advertise.ts            # v0 advertisement builders (upload/receive capability sets, peeled tags)
      UploadPack.ts           # v0 fetch choreography: request parse, negotiation, shallow, closure driver
      ReceivePack.ts          # v0 push choreography: command parse, probe, ingest driver,
                              # connectivity check driver, report-status
      GzipBody.ts             # Content-Encoding: gzip detection + DecompressionStream + 1f8b sniff
    store/
      Sql.ts                  # DDL (§3.1), typed query helpers, chunked-IN utilities, transactionSync wrappers
      ObjectStore.ts          # row/r2/pack placement policy, batched reads, thresholds, staging, r2_key resolution
      Keys.ts                 # R2 key scheme (§3.2)
      Closure.ts              # commit BFS (gen-bounded), tree walk, visited set, depth bounds
    jobs/
      Import.ts               # alarm job: git HTTP client against source, PackParser reuse, status flips
      Fork.ts                 # alarm job: parent snapshotRows Stream → batched inserts, r2_key sharing
      Purge.ts                # alarm job: bounded R2 prefix delete loop (fork-count-gated), deleteAll, Registry removal
  test/
    fixtures/stack.ts         # user-authored Alchemy.Stack over GitService() — one per suite
    fixtures/packs/*.pack     # generated once by real git, checked in (never at test time)
    codec.test.ts             # pure: pkt-line, varints, delta apply, object hashing, tree sort
    pack.test.ts              # pure: parse/write round-trips against checked-in fixture packs
    GitService.test.ts        # REST lifecycle via HttpApiClient against deployed URL
    GitProtocol.e2e.test.ts   # real git CLI against deployed URL (§9)
    GitProtocol.wire.test.ts  # isomorphic-git in-process client: malformed packs, forced thin REF_DELTA,
                              # ERR-pkt / band-3 assertions
examples/git-service/
  alchemy.run.ts              # user-authored Alchemy.Stack yielding GitService()
  package.json                # alchemy deploy | dev | destroy | logs | tail
```

Conventions honored: no `Input<T>` in props; Effect 4 APIs only (`Effect.result` + `Result.*`, `Schema.TaggedErrorClass`, `Schema.Literals`, `Effect.fn`); no `async/await`/raw Node IO in handlers (Effect platform services; sync CPU crypto/zlib wrapped in `Effect.sync` at module boundaries, not per-byte); file-based `main: import.meta.url` (never inline `script` — unsupported in dev); `@/` path alias; test fixtures own their directory; DO RPC methods avoid the reserved name `delete`; JSDoc `@section`/`@example` on exported classes for `bun generate:api-reference` (synthetic provider dir like better-auth).

---

## 7. Core codec plan: write it in Effect; the zlib boundary is `node:zlib`

**Reuse verdict: write our own; port algorithms, import nothing (at runtime).** isomorphic-git is Promise-based, filesystem-shaped, and not streaming-safe under 128 MB (it *is* used as a **devDependency test client** for wire-level negative tests); wasm-git drags libgit2 through WASM for a problem that is ~1500 lines of well-specified codec; ripgit's Rust is the right recipe in the wrong language. The wire formats are small, frozen, and exhaustively documented — the risk is in choreography, not codecs, and choreography must be ours anyway. Everything is pure functions / Stream transforms in `src/Git/Protocol/` with zero platform imports, so the entire codec layer unit-tests in plain bun without a deploy. Port with attribution: `applyDelta` (~80 lines) and tree sort-order from isomorphic-git; OFS-delta offset codec cross-checked against ripgit and gitformat-pack.

**The zlib boundary (the one platform-sensitive decision), per empirical workerd verification (workerd 1.20260801.1):**

| Need | Tool | Why |
|---|---|---|
| Pack entry parsing (unknown compressed span) | `node:zlib` `createInflate()` per entry | `end` fires at `Z_STREAM_END` mid-`write` without `.end()`, and `inflate.bytesWritten` reports the **exact compressed bytes consumed** — the only way to find the next entry. Native, one instance per object, cheap. `DecompressionStream` is disqualified: errors on trailing bytes, doesn't report consumption. |
| One-shot inflate of an exactly-known span (blob reads via index) | `zlib.inflateSync` or `DecompressionStream("deflate")` | Spans are exact so strictness is fine. |
| Request-body gunzip | `DecompressionStream("gzip")` | Single well-formed stream; pipe-through. Branch on `Content-Encoding: gzip`, sniff `1f 8b` defensively. |
| Compression at rest | `zlib.deflateSync(content)` (level 6) | Only runs for delta-resolved objects — the ingest fast path stores the pack's compressed span **verbatim** for non-delta entries. |
| Hashing | `node:crypto` `createHash("sha1")` incremental | Pack trailers and large objects; loose ids hash `"<type> <size>\0" + content`. |

`Protocol/PackParser.ts` (via a thin `Zlib` helper) is the **only** module allowed to touch `node:zlib`. No pako, no fflate.

Codec inventory: pkt-line reader/writer (65516 payload cap, flush/delim/ERR), sideband mux, type/size varint (little-endian 7-bit), OFS_DELTA offset (big-endian 7-bit **with the +1 bias per continuation** — the classic bug), delta instruction stream (copy/insert, `size==0 ⇒ 0x10000`), tree entry encode/parse with the `foo` < `foo/` directory sort quirk, commit/tag header parsing (continuation lines, gpgsig), pack header/trailer. Each has table-driven unit tests plus round-trip tests against real-git-generated fixture packs checked into `test/fixtures/packs/` (normal, thin, ofs-heavy, ref-delta, big-blob, empty), with `git index-pack --strict` / `git fsck` as the oracle for writer output.

---

## 8. Auth model: nothing inside the engine

The engine holds no credentials, no users, and no policy. Who may call
which route is decided by the `HttpRouter` middleware the user puts in front
of the routes, before the engine sees a request; the engine's routes
declare no middleware and no auth errors.

Every endpoint in `Api/*.ts` is an Effect `HttpApiEndpoint`.
The user defines their own API and composes its routes beside Git. `Git.ApiLive` is a native HttpRouter route layer,
merged beside `HttpApiBuilder.layer(AppApi)` by the application. `Git.ApiHandlersLive`
supplies the shared implementation. `Git.GroupsLive` exposes default native
group layers for applications that override a Git handler with
`HttpApiBuilder.group(Git.Api, ...)` and ordinary `Layer.mergeAll`.

The application owns authentication and the HTTP server. Its
`HttpRouter.middleware` layer applies to whichever public route layers it
chooses. Schema composition (`addHttpApi`) is independent of route registration.
There is no Git server wrapper and no application API argument.

The application can instead build its own API from the exported groups and
native `HttpApiMiddleware`. Every group must be built against that actual API.
Raw handlers still receive middleware-provided services.

`Git.Engine` provides transport-independent repository operations. The HTTP
adapter `ReceivePack.decode` reads bounded commands and retains the streaming
body. The handler authorizes the proposed refs, calls `preparePush`, optionally
reads staged objects to validate content, then calls `commitPush`. These are
scoped, single-use operations. Scope exit aborts uncommitted staging; cleanup
checks durable commit state before deleting spilled bytes. Git report-status
encoding lives in the HTTP adapter. There is no policy callback service.

Application policy functions use ordinary typed effects, including the request
user and database services. REST ref updates/removals use `prepareRefUpdate` /
`prepareRefRemoval`; merges use `prepareMerge`, pinning both inspected tips.
Applications call the same policies on every exposed write path, including
GitHub merges. `PushDenied` is encoded as a Git rejection or a typed JSON 403.

The push pipeline's internal hash route is not part of `Git.Api`: it is
`Git.InternalApi`, registered by `Git.InternalApiLive` beside public routes and
outside the user's middleware; it authenticates with `InternalSecret`, a
deploy-time `Alchemy.Random` value no user holds.

Tokens, users, and sessions are an implementation outside the engine:
the example uses Better Auth API keys (`@better-auth/api-key`) as the
git password and Better Auth sessions for browsers, both resolved in its
one middleware; anonymous callers read public repositories (the
middleware asks `Git.RegistryStore`). The test fixtures do the same with
two shared secrets. There is no tokens table and no admin key.

---

## 9. v1 test plan sketch

**Tier 1 — pure codec (no cloud, milliseconds):** `codec.test.ts` / `pack.test.ts` in plain alchemy-test. Table-driven pkt-line/varint/delta/tree-sort cases; parse→write→parse round-trips on checked-in fixture packs (generated once by real `git pack-objects`, committed — never generated at test time); thin-pack resolution against a fixture object store; the OFS +1-bias multi-byte offset case; the `0x10000` copy-size case; tree-sort fsck cases; zlib-boundary accounting (concatenated streams, trailing junk, mid-chunk `Z_STREAM_END`); PackWriter output accepted by `git index-pack --strict`.

**Tier 2 — deployed REST (`GitService.test.ts`):** standard harness —

```ts
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(), state: Cloudflare.state() });
const stack = beforeAll(deploy(Stack));            // fixtures/stack.ts
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
```

`HttpApiClient.make(GitApi, { baseUrl: url })` driving: create repo (admin key) → `RepoCreated` carries a working bootstrap token → 409 on duplicate → PATCH description/readOnly → mint read/write tokens → token list is masked → refs empty on fresh repo → REST ref update with CAS (`RefConflict` on stale `expectedOid`, `ObjectNotFound` on bogus oid, `ReadOnlyRepo` when flagged) → typed 404s decode as the tagged classes → token TTL expiry (60 s + bounded `Effect.repeat` poll) and revocation → 401/403 after → delete → `status: "deleting"` → eventual 404. First requests retried through edge propagation (`Schedule.spaced("1500 millis"), times: 40`). Deterministic repo names; pre-test purge of leftovers (delete-if-exists before create).

**Tier 3 — real git CLI e2e (`GitProtocol.e2e.test.ts`, the money suite):** deploys the same stack; drives the actual `git` binary via the Effect platform `Command` service against `https://x:${token}@${host}/${owner}/${repo}.git`, work-trees under `FileSystem.makeTempDirectory` (Effect platform services only — no `node:fs`). Every step wrapped in bounded retries/timeouts per the speed doctrine (per-test ≤ 120 s):

1. **Empty-repo clone** — clone succeeds, warns empty, correct default branch (symref/unborn behavior).
2. **First push** — init, 3 commits (incl. an executable file, a symlink, a subdirectory), `git push` → `ok` report; REST `refs` + `commits/:oid` + `trees/:oid` + `/file` agree with `git rev-parse`/`git ls-tree`/`git show` byte-for-byte.
3. **Clone-back + fsck** — fresh clone, `git fsck --strict` clean, `git log` matches. (Transitively proves advertisement, negotiation, pack emission, object round-tripping.)
4. **Incremental fetch** — push 2 more commits from clone A; `git fetch` in clone B; fast-forward merge; content identical (asserts the haves/ACK path, not just re-clone).
5. **CAS / force push** — non-FF push rejected (`ng fetch first`), then `push --force` succeeds; fetch-after-force-push works in the other clone. **CAS race**: two clones push conflicting updates concurrently → exactly one `ok`, one `ng`; `--atomic` batch is all-or-nothing.
6. **Concurrent push serialization** — two parallel pushes to one repo → both eventually succeed (semaphore wait) or the second sees 503 + retry; never a corrupted repo.
7. **Branch + tag lifecycle** — push new branch, push **annotated** tag (round-trips as a tag object, peeled `^{}` in advertisement — ripgit's silent-drop bug is a named regression test), `git push --delete` both.
8. **Shallow** — `git clone --depth 1` succeeds; `git fetch --deepen 1` extends it.
9. **Large blob** — commit a 3 MiB random binary (deterministic seed), push, clone back, byte-identical (exercises `location='r2'` both directions).
10. **Big-ish push** (`skipIf(process.env.FAST)`) — ~2 000 deterministic commits (fixture script, cached tarball) push and clone within timeout (exercises thin-pack ingest with deep delta chains).
11. **readOnly** — flag repo readOnly, push → per-ref `ng`; unflag, push succeeds.
12. **Auth matrix** — read token clones but push → 403/`ng`; garbage token → 401 + git auth-retry stderr; token in remote URL works.
13. **Fork + import** — fork, poll `status` via `Effect.repeat` until `ready`, clone fork, histories identical, push divergent commit to fork → parent unaffected; **delete parent → fork still clones** (R2 fork-retention pin). Import from a sibling repo in the same deployment (avoids external flake), verify refs; optionally a small public repo depth-limited.
14. **Cleanup pin** — `stack.destroy()` at suite end; out-of-band distilled verification that the R2 prefix and Registry rows are gone (leak = provider bug by definition).

**Tier 3b — wire-level negative tests (`GitProtocol.wire.test.ts`):** isomorphic-git as an in-process HTTP client for cases needing byte-level control without shelling out: truncated pack → checksum `ng`; forced thin REF_DELTA against known base; pack referencing a missing tree → connectivity-check `ng`; oversize pack → clean in-band 50 MiB rejection; `ERR` pkt / band-3 assertions.

Per house rules: `bun run test test/... --profile testing` wrapped in `timeout 240`; `Effect.repeat` with bounded schedules for all polling (never `while(Date.now())`); deterministic names (never `Date.now()`); `NO_DESTROY=1` for local iteration.

---

## 10. Cut list & v2 seams

Every cut, its consequence, and the seam that makes it additive (seams marked **▲** are already load-bearing columns/interfaces in v1's shape):

| Cut | Consequence | Upgrade path |
|---|---|---|
| Protocol v2 | None visible — clients fall back to v0 silently | Additive: branch on `Git-Protocol: version=2` in `info/refs`, add `ls-refs` + `fetch` command handlers over the same `Closure` + `PackWriter` code. Advertisement/choreography are per-version files — a new file, not a rewrite. |
| ▲ Pack compaction / R2 packs (v1.1) | DO storage cost 13× R2 until it lands; 1 M-object manifest cap | `objects.location='pack'` + `pack_id`/`pack_offset` columns exist; emitter dispatches on location; alarm scaffolding present. Clone fast-path then streams whole entry-regions from R2 (B's verbatim-region trick — OFS offsets are entry-relative, so contiguous regions copy safely). |
| ▲ Streaming push > 50 MiB | Large initial pushes rejected (clean in-band report) | `PackParser` is written against `RandomAccess`; swap the memory buffer for an R2-multipart tee + ranged-read re-resolution. Plan body caps (100 MB Pro) remain the outer bound. |
| `thin-pack` / `ofs-delta` in **served** packs | Fatter fetches (~1.3–2×, no cross-object compression) | Delta-aware writer, or serve compaction packs (which may carry deltas) verbatim for clones. |
| `filter` (partial clone) | v0 clients warn and ignore; `--filter` unavailable | Advertise `filter`; `blob:none`/`blob:limit` are manifest predicates — the walk already knows types/sizes. |
| `include-tag` | Clients cope (fetch tags explicitly) | Tag-closure step in `Closure`. |
| `deepen-since` / `deepen-not` / `deepen-relative` (`git fetch --deepen`) | Rare flags fail (absolute `--depth <n>` deepening works) | ▲ `commits.commit_time` already stored; add walk predicates. |
| Multi-round minimal negotiation | Slightly fat incremental fetches (boundary snapshot redundancy) | ▲ Real common-ancestor negotiation over `commits`/`commit_parents` + `gen` — all data present. |
| `packfile-uris` | — | Natural once compacted packs exist: presigned R2 URLs for whole packs. |
| push-cert, push-options | Not advertised ⇒ clients don't send them | Add protocol parsing and expose decoded data to application handlers. |
| Force-push / branch protection | Any write token can force-push | Policy table consulted inside the existing CAS `transactionSync` — pure addition. |
| Object-level GC | Unreachable objects persist (storage is the cheap resource) | Reachability sweep in the GC alarm; fork-aware deletion needs the refcount ledger below. |
| Shared-pack refcount ledger | Fork-retention rule is coarse (`fork_count > 0` retains the whole prefix forever) | Registry-maintained per-key refcounts on fork/delete → precise shared-object GC. |
| Dumb HTTP | None (modern git never falls back when smart content-types are correct) | Never. |
| SHA-256 repos | `object-format=sha1` advertised; mismatch rejected with `ERR` | ▲ `Oid` is branded; widen schema + dual hashing. |
| LFS | Large files ride normal objects up to the 64 MiB cap | LFS Batch API as an independent REST group + R2 streaming (chr33s reference); keys `{repoId}/lfs/<sha256>` reserved. |
| Registry sharding / global listing at scale | Singleton Registry serializes control-plane writes | ▲ `getByName("registry:" + owner)` — RPC interface unchanged. |
| Users / orgs / OAuth / public repos | Single admin key + capability tokens only | ▲ `Credentials` Context service boundary; edge-auth worker via service binding. |
| Cheap forks / big-repo import | Fork copies parent row bytes; import capped at 50 MiB pack | Falls out of compaction (bytes in shared R2 packs) + streaming ingest — both seams above. |
| PRs / issues / review | — | New tables in the Repo DO (it already holds the commit graph; merge-bases are `commit_parents` BFS), new HttpApi groups; the REST layer grows by group addition, not restructuring. |

---

*Implementable from this document plus the repo: start with `src/Git/Protocol/` (Tier-1 tests green offline), then `Store/`, then `RepoObject.ts` choreography, then the Worker/API mount, then the e2e suite. `packages/alchemy/src/Cloudflare/StateStore/Api.ts` is the mounting reference; `test/Cloudflare/Workers/fixtures/http-api/` is the Worker+DO+R2 reference; `packages/better-auth` is the packaging reference.*
---

# Part II — v2: scaling to enormous repositories

v1 is deliberately one Durable Object per repo holding **everything**: refs,
the object index, and the object bytes. That buys transactional ref CAS for
free and is provably correct (Part I), but it caps out on two axes:

- **Storage** — DO SQLite is 10 GB, so bytes-in-rows caps a repo at ~10 GB.
- **Bandwidth** — every clone byte transits one single-threaded DO in one
  datacenter. No horizontal read scaling, no geographic spread.

The v2 insight: **a git repo is 99.9% immutable content-addressed bytes and
0.1% mutable transactional state.** Immutable content-addressed data needs
*zero* coordination, so it should never live behind a coordination point.
Sharding the DO would be solving a problem we should not have. Instead,
split the planes.

## 11. The three planes

| Plane | Home | Holds | Scales by |
|---|---|---|---|
| **Refs** (mutable) | Repo DO | refs, tokens, config, push staging, commit graph | Nothing needed — kilobytes; the only thing that requires serialized CAS |
| **Objects** (immutable) | R2 | content-addressed packs + pack indexes + clone bundles | R2 (unbounded, immutable keys, no per-key write contention) |
| **Serving** (stateless) | Workers + Cache API | advertisement, negotiation, pack streaming | Per-PoP: every datacenter serves independently |

The DO stays the authority for "what is the current tip", which is the only
question that needs an authority. Everything else is content-addressed and
therefore cacheable, shareable, and replicable without coordination.

### 11.1 Why this is the right shape

This is the same refs-in-database + objects-in-blob-store architecture that
GitHub (Spokes), GitLab (Gitaly + object storage), and AWS CodeCommit
(DynamoDB + S3) converged on, expressed in Cloudflare primitives. The
difference from v1 is not "more machines" — it is *removing the byte path
from the coordination point*.

### 11.2 Request flows after v2

```
clone (warm)   client → Worker → Cache API hit                    (DO: 0 calls, R2: 0 gets)
clone (cold)   client → Worker → DO.planClone (refs only, ~1 KB)
                              → R2 GET bundle → stream to client  (DO: 1 tiny RPC)
fetch (incr.)  client → Worker → DO.planFetch (negotiate on the
                              commit graph) → R2 ranged reads     (DO: 1 tiny RPC)
push           client → Worker → DO (ingest + CAS, unchanged)     (serialized, by design)
```

## 12. Object plane: packs, indexes, bundles

### 12.1 Compaction (loose rows → R2 packs)

An alarm fires when `SUM(zsize) WHERE location='row'` exceeds **1 GB** or the
live loose count exceeds **50 000**. It streams a no-delta pack of the
oldest N objects to R2 via multipart (5 MiB parts), then flips those rows to
`location='pack'` with `pack_id`/`pack_offset` in one `transactionSync` and
NULLs their `zdata`.

Because objects are stored **pre-deflated** (v1's decision, made for CPU
reasons), a pack is literally `varint header + zdata` concatenated — so
compaction is a copy, not a recompression, and `pack_offset` points at a
byte span that can be served by an R2 ranged read verbatim.

Keys are content-addressed and immutable:

```
{repoId}/packs/pack-{sha1}.pack     compacted objects (immutable)
{repoId}/bundles/bundle-{refsHash}.pack   full-clone bundle (immutable)
{repoId}/objects/{oid}              oversize loose objects (v1, unchanged)
```

**Only blobs are packed (DESIGN §22).** `Compact.ts` selects `type = 3`
rows exclusively; commits, trees and tags stay `location='row'` in SQLite
for the life of the repo, and the REST `ObjectStats` reports them as
`resident` (distinct from `loose`, which is now *blobs awaiting
compaction*). The reason is the fetch path: the want→have closure is a
tree walk, and a tree walk over pack storage is the worst access pattern
a window cache can see — trees are tiny and, packed in oid order, land in
every 4 MiB window of every pack. On a 15.6k-object repo that walk alone
cost 12 s of TTFB after batching (27 s before). Over rows it is a handful
of batched `SELECT ... IN` calls. Commits and trees are a few percent of a
repo's bytes, so keeping them local buys sub-second negotiation for every
incremental fetch at negligible SQLite cost.

### 12.2 Clone bundles

A clone is, on the wire, exactly one pack containing the closure of the
advertised refs. v1 recomputes that pack per clone. A **bundle** computes it
once, after pushes settle (debounced alarm), and stores it under a key
derived from the ref snapshot it covers (`refsHash`).

Serving a clone then becomes: match the request's wants against the current
advertisement, and if they agree, stream the bundle bytes. No closure walk,
no per-object reads, no compression — and the bytes are immutable, so the
Cache API can serve them from every PoP.

Staleness is handled in three escalating tiers:

1. **Exact match** (v2.0) — bundle covers exactly the current refs → stream
   it; otherwise fall back to dynamic assembly. Hot repos with bursty clone
   traffic (CI fleets cloning the same tip) hit this nearly always.
2. **`packfile-uris`** (v2.1, needs protocol v2) — the server hands the
   client a CDN URL for the big pack and sends only the remainder in-band.
   The bundle no longer has to be current, only *mostly* current.
3. **`bundle-uri`** (v2.2, git ≥ 2.38) — advertise a base bundle plus
   incrementals with `creationToken`s; the client fetches them all from
   cache and then does an ordinary incremental fetch. Server work per clone
   collapses to a tiny negotiation.

Bundles are derived data: GC keeps the newest base plus K incrementals and
deletes older ones lazily. Because keys are content-addressed, a new bundle
never overwrites an in-flight one.

### 12.3 The object index at scale

If the index itself outgrows the DO (~10M+ objects), the answer is again not
a shard: the **pack index files in R2 are the index** (binary-searchable by
oid), and the oid's own hash prefix is a perfectly uniform partition key if
they ever need splitting. Content addressing *is* the trie — there is no
tree structure to invent.

## 13. Serving plane: Workers + Cache API

- **Advertisement caching.** `GET /info/refs` output changes only on push,
  so it is cached under a key derived from the repo id + refs hash and
  purged on push. A clone storm then costs the DO ~one call *per push*
  rather than one per clone.
- **Worker-side clone fast path.** The Worker asks the DO for a *plan*
  (`planClone`: refs snapshot + bundle key, ~1 KB) and, when the plan says
  "bundle", streams R2 → client itself, framing sideband as it goes. The DO
  never touches a pack byte.
- **Dynamic fetches** stay proxied to the DO in v2.0 (they need the commit
  graph); v2.1 moves negotiation to the Worker over a cached commit-graph
  file, leaving the DO purely as the ref authority.

## 14. Scaling model (napkin math)

Everything is per-repo; repos are independent DOs, so fleet capacity is the
sum. These are estimates derived from platform limits and architecture, not
measurements — §15 is the plan to replace them with numbers.

| Dimension | v1 (as built) | v2 (this design) | Bound by |
|---|---|---|---|
| Clone bandwidth (per repo) | ~50–100 MB/s aggregate | edge line rate; Tbps-class aggregate | v1: one DO streams every byte. v2: immutable bytes in cache/R2 |
| Clone TPS (per repo) | ~50–200/s | 10k+/s | v2: advertisement cached; DO called ~once per push |
| Incremental fetch | ~1–5 s CPU per 1M-object closure | ms for recent tips | commit graph + (v2.1) bitmaps |
| Push TPS (per repo) | ~3–10/s | ~5–20/s | **Inherent**: a ref is a serialization point in git's own semantics |
| Repo size | ~10 GB | unbounded (R2) | DO SQLite cap lifted off the byte path |
| Push size | 50 MiB | unbounded | `RandomAccess` seam → R2 multipart tee |

**v2 makes reads scale like a CDN and leaves writes scaling like git** —
which is the correct place to land, because git's semantics cap per-ref
write concurrency regardless of who hosts it.

## 15. Remaining bottlenecks (ranked) and how each is measured

1. **Cold closure computation on enormous repos.** A 10M-object visited set
   as a JS `Set` is ~400 MB–1 GB, over the Worker's 128 MB. Fix is git's own:
   binary commit-graph + **reachability bitmaps** (EWAH), turning a 10M-node
   walk into bitmap ANDs over a few MB. This is the hardest real engineering
   on the path to enormous repos.
2. ~~**Subrequest limit (1000) vs. fragmented packs.**~~ **Addressed**
   (§16.2): pack reads are served from window-aligned slabs, so a fetch
   costs a handful of R2 GETs rather than one per object (68.2 s → 1.16 s
   on a 1202-object pack). Remaining work is pack *ordering* — laying out
   compaction output so a typical fetch touches few windows — which is an
   optimization now rather than a cliff.
3. **Per-repo push serialization.** Inherent (see above); measured, not
   fixed.
4. **Registry singleton** — ~500 control-plane ops/s globally. Resolve
   caching shields reads; `getByName("registry:" + owner)` shards writes.
5. **First-byte latency for distant clients** — the refs DO lives in one
   datacenter. Cached advertisements hide most of it; location hints place
   hot repos near their users.
6. **R2 write throughput during compaction/bundling** — a large repack is
   minutes of alarm work; must use the bounded-per-run + re-arm pattern the
   purge job already uses (15-minute alarm budget).

Each gets a benchmark in `test/GitBench.e2e.test.ts` (§16) so the table
above becomes measured numbers rather than estimates.

## 16. Measured (test/GitBench.e2e.test.ts, deployed, SCALE=1)

Run: `bun run test test/GitBench.e2e.test.ts --profile testing`
(`BENCH_SCALE=4` for 4× workloads). Each case asserts only correctness and
prints a line, so a slow datacenter minute can never fail the suite.

### 16.1 End-to-end (via the `git` CLI, so client cost is included)

| Measurement | Result | Reading |
|---|---|---|
| push 300 commits | 2.0 s (147 commits/s) | one push, ingest-dominated |
| clone — dynamic closure walk | 1.17 s | v1 path: walk + per-object reads |
| **clone — R2 bundle** | **0.44 s** | **2.7× faster** |
| clone — fully packed repo (ranged R2 reads) | 0.60 s | compaction costs ~35% vs bundle, still beats dynamic |
| incremental fetch (1 commit) | 477 ms | 2 round trips + negotiation |
| 8 concurrent clones, 256 KiB each | 9.9–10.7 clones/s | bound by `git` process spawn + TLS, **not** by the server |
| 10 serial pushes (same branch) | 4.6 pushes/s | the predicted per-ref serialization floor |
| 4 concurrent pushes (distinct branches) | 9.2 pushes/s | DO semaphore serializes ingest, by design |
| 10 concurrent repo creates | 7.9–12 creates/s | Registry singleton |
| repo GET (resolve-cached) | 25 ms | in-isolate cache hit |
| repo LIST, 13 rows → 14 rows | **416 ms → 27 ms** | **15×** after fixing the N+1 (below) |
| compact 202 loose objects → R2 | 0.9 s | ~220 objects/s |

### 16.2 Server capacity — the v2 claim, measured

Driving `git-upload-pack` over raw HTTP removes the client from the
measurement. Comparing the bundle path against the dynamic closure walk
(forced by sending a `have` the server does not know, which disqualifies
the bundle while producing the identical pack) is like-for-like:

| Concurrency | dynamic closure walk (v1 path) | R2 bundle via Worker (v2 path) |
|---|---|---|
| 1 | 4.7 clones/s, 2.4 MiB/s | 5.4 clones/s, 2.7 MiB/s |
| 8 | 17.2 clones/s, 8.7 MiB/s | 17.9 clones/s, 9.1 MiB/s |
| **32** | **20.2 clones/s, 10.2 MiB/s** | **62.1 clones/s, 31.5 MiB/s** |

Dynamic fetch over a **compacted** repo (1202 objects in one R2 pack), the
case bottleneck #2 warned about:

| | |
|---|---|
| one ranged GET per object (naive) | **68.2 s** for a 53 KiB fetch |
| coalesced window reads | **1.16 s** (59×) |

Reading a pack object-by-object costs one serialized R2 round trip each.
Window-aligned slabs (4 MiB, ≤6 retained) mean touching any object fetches
its whole neighbourhood once, so a small pack collapses to a single GET —
and the Workers subrequest budget stops being a correctness cliff.

This is the design's central claim, measured. The dynamic path **saturates
at ~20 clones/s** — one Durable Object's single-threaded ceiling, and more
load does not improve it — while the bundle path keeps scaling with
concurrency (3.1× at 32-way, still climbing). Serialized planes flatten;
immutable content-addressed bytes served by Workers do not.

### 16.3 Real world: this repository (test/GitRealWorld.e2e.test.ts)

The strongest test we have is pushing the alchemy monorepo itself — a
depth-1 tree re-committed as one root commit, which keeps the real object
count and byte volume while staying fully connected (pushing from a shallow
clone would reference parents the server does not have, which receive-pack
correctly refuses):

| Step | Result |
|---|---|
| push 12,315 files / 13,699 objects / 38.1 MiB | 20.6 s |
| clone back, loose objects | 19.5 s |
| **clone back after compaction (R2 packs)** | **3.4 s — 5.7×** |
| `git fsck --strict`, HEAD and tree oid equality | identical |
| incremental push on top | works |

Compaction making clones **5.7× faster** on a real repo is the v2 storage
plane paying off end to end: the same objects, read as a few large ranged
GETs out of an immutable pack instead of thousands of row reads.

Verification note: the suite deliberately does **not** `diff -r` the two
working trees. Tree-oid equality is the stronger and correct assertion —
identical tree oids mean every path, mode and blob matches — whereas a
directory diff also compares things git does not track (empty directories,
submodule mount points), which legitimately differ between a working tree
and a fresh clone of it.

### 16.4 Push size: the cap is gone, the large path needs a cursor

A push larger than the in-memory threshold is **no longer rejected**. The
body is parked in R2 and parsed back through `Store/PackSource.ts`, an
R2-backed `RandomAccess` with window-coalesced reads — the seam
`PackParser` was written against from the start. The DO's ingest now runs
on `PackParser` (which the pack fixtures cover directly) rather than its
own buffer-only copy.

Getting there took one real fix. `PackParser` read **the entire remainder
of the pack for every entry** (`source.read(offset, dataEnd - offset)`).
On a buffer that is free — a subarray view — which is why nobody noticed;
against R2 it copies ~19 MiB per entry, so a 13.7k-object pack moved
hundreds of gigabytes and blew a 600 s timeout. Entries are a few KiB, so
the parser now reads a bounded 512 KiB window and grows it only for the
rare object whose compressed stream runs past it.

| 38 MiB alchemy push | before | after |
|---|---|---|
| via R2 (streamed ingest) | >600 s (timeout) | **44.4 s** |
| in memory | 20.6 s | 20.6 s |

So the R2 path costs about **2×** memory rather than 30×, and the
threshold ships at 32 MiB — comfortably inside a 128 MB isolate, covering
the overwhelming majority of pushes at full speed, with anything larger
merely slower instead of refused.

### 16.5 Public repos — anonymous read access

Repos carry a `public` flag (GitHub's model). Tokenless callers are
`{ kind: "anonymous" }` in `CallerAuth` and get exactly one grant: `read`
on repos whose flag is set — REST reads, raw file/blob routes, the
advertisement, and `upload-pack` (tokenless `git clone`). Writes, token
management, and everything on private repos still require a token;
anonymous wire requests to private repos answer `401 + WWW-Authenticate`
so git prompts. Listing is visibility-filtered: the admin key sees all
rows, everyone else sees `is_public = 1` only (denormalized into the
Registry, like the other list columns). Enforcement stays in the Repo DO
(`authorize`/`wireAuth`) — the Worker middleware only parses credentials,
and a missing `Authorization` header now parses to anonymous instead of
401.

### 16.5 The push cap was still there — request buffering

Pushing the **full alchemy history** (~100 MiB pack) found the residual
cap: the DO read the request with `request.arrayBuffer`, materializing the
whole body inside the 128 MB isolate before any parsing — OOM, 500, after
~7 s. Everything downstream (R2 parking, windowed parsing) was already
size-independent; the *receive* wasn't.

The fix is `Store/IncomingBody.ts`: the body is consumed as a stream.
Bodies that finish within `MAX_PACK_BYTES` return as one buffer (the fast
path); the moment the threshold is crossed, everything received and
everything still arriving spills to R2 via **multipart upload** in uniform
8 MiB parts, so peak memory is ~threshold + one part no matter how large
the push. A 1 MiB head is retained for the pkt-line command section, and
the pack is parsed back off R2 through `sliceRandomAccess` + windowed
reads. gzip bodies (git only gzips requests it fully buffered, i.e. small
ones) keep the buffered path; a spilled gzip body is rejected in-band.

Measured, full alchemy `main` (44,051 objects, 67 MiB thin pack):

    push:        92 s wall — server ingest 76.8 s (SQL 5.7 s)
    clone back:  50.6 s, 152.8 MiB; `git fsck --strict` clean, HEAD identical

Also worth recording: Cloudflare's edge caps request bodies at 100 MB on
most plans, so beyond that git needs its transfer split (`git push` per
ref / partial history first) regardless of what this service does.

### 16.6 Ingest batching, and what it revealed

Staging cost **two statements per object** — an existence probe and an
insert — so a 13.7k-object push ran ~27k statements and ~13.7k transactions
inside one single-threaded Durable Object. Ingest now stages in batches of
256 (or 8 MiB) via a single `transactionSync` with `INSERT OR IGNORE` (no
probe), adopting crashed-push rows with one chunked `UPDATE`, and the
parser hands the sink its already-inflated bytes so commits/trees are not
inflated twice.

    38 MiB alchemy push via R2:  44.4s -> 37.4s
    clone back:                  18.5s -> 16.6s

A 16% win, not the 5x the statement count suggested — which is the useful
result: **transaction commits were not the dominant cost**. What remains is
per-object work that batching cannot remove (inflate, sha1, one statement
each, Effect frames) plus, importantly, *client-side* cost the measurement
does not separate: `git push` also packs 13.7k objects locally and uploads
38 MiB over the tester's uplink. Isolating server ingest needs either
server-side timing or a loopback baseline — until then these numbers are an
upper bound on server cost, not a measurement of it.

The deeper point is that this work is **serial by construction**: one repo
is one Durable Object, and a push is one request to it. No amount of
horizontal Worker/R2 scale touches it. Making a single large push
dramatically faster requires parallelism *within* the repo — see §17.

### 16.7 What the measurements corrected

1. **`repos.list` was O(N) Durable Object wakes** — the handler fanned out
   `getRepoMeta` per row, so listing 100 repos woke 100 DOs. **Fixed**:
   `default_branch` / `read_only` / `status` are denormalised onto the
   registry row (the Repo DO pushes them on change and remains the source
   of truth). 416 ms → 27 ms. Live `objects` stats still need the DO, so a
   listing reports zeros there and callers who want them read the repo
   directly. Note for future schema work: the Registry needed an explicit
   `ALTER TABLE` migration, because `CREATE TABLE IF NOT EXISTS` silently
   leaves an existing table's columns alone.
2. **Small-clone throughput is round-trip-bound, not bandwidth-bound.** At
   256 KiB per clone the git client's process spawn plus two HTTP round
   trips dominate, so the bundle win shows up as latency; the bandwidth
   ceiling only appears under raw concurrency (§16.2) or on much larger
   repos.
3. **Advertisement caching is deliberately NOT implemented.** A TTL cache
   on `info/refs` would make "push, then fetch from another machine"
   unreliable for the length of the TTL — a real correctness regression for
   CI. Doing it properly means an epoch the Worker can read without asking
   the DO (Cache API entry purged on push), which is a v2.1 item; the
   remaining per-clone DO cost is two small RPCs, and §16.2 shows that is
   not the ceiling.

---

# Part III — v3: the maximum-performance DO architecture

## 17. Why v2 still has a floor

v2 made *reads* scale (immutable bytes served by Workers from R2) and left
*writes* where git semantics put them. But the measurements in §16 expose a
floor that no amount of horizontal scale removes:

- one repo = one Durable Object = **one thread**;
- a push is **one request** to it;
- ingest is ~13.7k objects × (inflate + sha1 + one statement + Effect
  frames), strictly serial.

Batching transactions bought 16% (§16.5) — proof that the remaining cost is
per-object work, not commit overhead. Making a large push an order of
magnitude faster requires parallelism **inside the repo**.

The enabling observation: a repo holds two kinds of state with completely
different constraints.

| | mutability | ordering | consequence |
|---|---|---|---|
| refs, tokens | mutable | CAS, strictly serialized | must live in one DO |
| objects | **immutable, content-addressed** | **none whatsoever** | can be written anywhere, in any order, in parallel |

Object writes are serialized today only because they share a DO with the
refs. That serialization is *accidental*, not essential.

## 18. Target architecture

| Tier | Instances | Holds | Why here |
|---|---|---|---|
| **Worker** | horizontal | pack parsing (inflate + sha1), fan-out, response assembly | stateless CPU; parsing has no reason to sit in a coordination point |
| **Ref DO** | 1 / repo | refs, tokens, commit graph, push staging state, CAS | the only thing git forces to serialize |
| **Object shard DO** | N / repo, by oid prefix | content-addressed objects (hot tier) | independent writes ⇒ N-way parallel; N × 10 GB ceiling |
| **R2** | — | compacted packs, clone bundles | immutable bulk, ranged reads, no egress |

**Sharding key: the oid itself.** An oid is a uniform hash, so a fixed
2-hex-char prefix distributes perfectly with zero rebalancing. A trie or
dynamic split solves skewed key distributions — a problem content
addressing does not have. Fix `N = 256` at repo creation and never reshard:
256 × 10 GB = 2.5 TB per repo.

**Why fan-out is safe.** Staging across shards is not atomic and does not
need to be: objects are immutable and content-addressed, so a partial write
is inert (worst case some staged rows are GC'd). The only atomic step is
the ref CAS in the ref DO, which runs after the connectivity check passes.
Sharding never touches the consistency-critical path.

**Cost shape.** DO *instances* are not billed; requests, active duration and
storage are. Fan-out means one RPC per shard **touched** (objects batched
per shard), so ~256 requests for a large push (~$0.00004) and far *less*
total active duration, since 256 DOs busy ~50 ms beats one DO busy 20 s.
The real costs are cold-start latency across shards and a wider failure
surface — both mitigated by immutability making every retry free.

## 19. Phases

**Phase 0 — measure honestly (prerequisite). DONE — and it settled the
question.** Repos now report `lastPush` timing measured inside the Durable
Object. For the 38 MiB / 13,701-object alchemy push:

| | |
|---|---|
| **server ingest** | **27.0 s** |
| connectivity check | ~0 ms |
| ref CAS finalize | ~0 ms |
| **server total** | **28.7 s of a 32.3 s wall clock (89%)** |
| client + network | 3.5 s |

So the earlier suspicion that client packing and upload dominated was
**wrong**: the server owns 89% of the time, and effectively all of it is
the per-object ingest loop at **2.10 ms/object**. Connectivity and CAS —
the parts that genuinely must be serialized — are free.

**Phase 0b — where the ingest time actually goes.** Splitting `ingestMs`
settled the next question too:

| | | |
|---|---|---|
| SQL staging | 2.0 s | **9%** |
| CPU (inflate, sha1, parse, Effect frames) | 20.4 s | **91%** |

So **sharding storage addresses only 9%** of push cost. It remains valuable
for the 10 GB → 2.5 TB capacity ceiling, but it is not the throughput fix.
The throughput fix is per-object CPU — and 1.49 ms to inflate ~2.7 KB and
hash it is ~50x the cost of the actual work, i.e. it is overhead, not
computation.

First cut at that overhead: `zlib.createInflate()` built a Node Transform
stream (EventEmitter, buffers) and took an async event-loop round trip **per
object**. Driving the engine synchronously the way Node's own `inflateSync`
does removes both:

    CPU        20.4s -> 15.9s     per object  1.74ms -> 1.42ms
    wall clock 28.1s -> 23.2s

with a hard-won caveat baked into the code: workerd's `node:zlib` shim
returns only the *first chunk* (observed: 525,107 bytes of a 1,337,267-byte
object) and reports a plausible `bytesWritten` alongside it, where Node
loops until done. The fast path therefore validates its output against the
size the pack header already declares and falls back to the stream path on
any mismatch — silent truncation would otherwise corrupt objects. Pack
fixtures alone would not have caught this; only the deployed push did.

Remaining per-object overhead to attack next, in order: `crypto.createHash`
allocated per object (same shape of problem as `createInflate`), Effect
frames in the sink, and window slicing.

That is still the argument for phases 1–2, but with corrected weights: the expensive work
(inflate, sha1, one insert) is *per object* and has no ordering
requirement, yet runs single-threaded because it shares a DO with the refs.
At 2.10 ms/object, 16-way fan-out puts a 13.7k-object push at ~1.7 s.

**Phase 1 — hoist pack parsing to the Worker.** Inflate + sha1 for every
object currently runs on the ref DO's single thread; it is stateless CPU.
Moving it to the Worker frees the DO and is the prerequisite for fan-out
(the Worker must hold resolved objects to route them).

**Phase 2 — shard the object store.** `ObjectShard` DO addressed
`{repoId}:{oidPrefix}`; `ObjectStore` becomes a router that batches by
prefix and writes shards in parallel. Connectivity checks become N parallel
batched queries. Compaction runs per shard, producing per-shard R2 packs.

**Phase 3 — parallel fetch assembly.** A dynamic fetch reads its manifest
from N shards concurrently instead of walking one DO.

**Phase 4 — reachability bitmaps.** With throughput fixed, the remaining
ceiling is closure computation on multi-million-object repos: EWAH bitmaps
over the commit graph replace the visited-set walk.

Expected shape of the win: 13.7k objects at ~1.5 ms serial ≈ 20 s; fanned
across even 16 shards with parsing overlapped in the Worker ≈ 1–2 s.


## 20. GitHub REST v3 compatibility (Tier 1)

`src/GitHubCompat.ts` mounts a `/api/v3/**` facade so GitHub-flavored
tooling talks to the service unmodified:

```sh
export GH_HOST=git.example.com          # your deployed host (https)
export GH_ENTERPRISE_TOKEN=gs_...       # admin key or repo token
gh api repos/alchemy/alchemy            # → GitHub-shaped JSON
gh api repos/alchemy/alchemy/pulls -f state=open
gh api -X POST repos/o/r/pulls -f title=T -f head=topic -f base=main
gh api -X PUT repos/o/r/pulls/1/merge
```

The facade is a pure translation layer over the same Repo-DO RPCs as
`/api/v1` (auth enforcement unchanged, anonymous reads on public repos
included). Covered: `/user`, repo get, branches, commits (list/single with
files), contents, and the full pulls lifecycle. GitHub-isms handled:
`Authorization: token` scheme, merged-PR = `closed`+`merged: true`,
`{ message }` errors, `Link: rel="next"` pagination carrying opaque keyset
cursors (`gh api --paginate` and Octokit follow them verbatim).

Out of scope, deliberately: GraphQL (so `gh pr ...` porcelain does not
work — use `gh api` paths), issues/reviews/comments/checks/search, rename
detection, and additions/deletions counts (always 0; content diffs are
client-side by design). `gh` requires https for enterprise hosts, so the
facade is exercised locally by shape tests replaying gh's exact wire
requests (verified against `GH_DEBUG=api` output) and by `gh` itself only
against https deployments.

## 21. Learnings from Cursor's Continuity (git-at-any-scale)

Cursor's Continuity ([blog](https://cursor.com/blog/git-at-any-scale))
solves the same problem shape — git on object storage with a single
linearization point — with one structural inversion worth studying: for
them **object storage is the source of truth** (a WAL of pushed packs +
a tiny WAL-index object updated by compare-and-swap), and every server
disk is a disposable warm cache rebuilt from the WAL. For us the Durable
Object's SQLite *is* the truth and R2 holds derived artifacts. Their
compute is fungible and their storage is authoritative; ours is the
opposite. What transfers:

**Adopt — the push WAL (durability + provenance).** Today the DO's
SQLite is the only representation of refs/index/graph; the received pack
is exploded into rows and discarded. Appending a small WAL record per
push to the BlobStore — `{ pushId, refTxn (old→new per ref), packKey,
subject, timestamp }` plus the self-contained (fattened) pack — makes
the entire repository reconstructable from blob storage alone: disaster
recovery independent of DO state, byte-level push provenance ("rewind
and fast-forward", audit paired with the auth `subject`), backend
migration, and future read replicas. This composes with the planned
push-epoch redesign (§19 / RFC): the epoch record *is* the WAL entry —
make it durable in the BlobStore instead of a SQLite row and both
designs land in one change. Storage cost is bounded by folding WAL packs
into compaction epochs (Continuity compacts the WAL too).

**Adopt — geometric pack compaction.** `Compact` currently writes one
new pack per run and never merges packs, so pack count grows with
repository age and read fan-out grows with it. Continuity's incremental
geometric compaction (merge packs whenever sizes violate a geometric
progression) bounds pack count logarithmically. Directly applicable to
our Compact job; also the precondition for WAL-pack folding above.

**Adapt — conditional-GET freshness for DO-less reads.** Continuity
replicas serve reads after a ~10 ms conditional GET on the WAL index
(304 = current). Mapped onto us: a tiny `head` object in R2 (ref
snapshot hash + current bundle key), updated at push finalize, would let
**Workers serve advertisements and clone bundles without waking the DO**
— the clone-storm path goes fully DO-less while the DO remains the write
linearization point. The subtlety is commit ordering: SQLite commit is
our truth, so the head object is written after commit and a crash
between the two leaves it stale. Either accept bounded staleness with
repair-on-next-push, or move the commit point into the head-object CAS
itself (the full Continuity inversion — a much bigger change). Start
with the former.

**Adapt — repos as cattle (hibernation).** Continuity garbage-collects
idle replicas and re-materializes from the WAL on access. Our analog:
once a WAL exists, an idle repo's DO can evict object rows (or all
state) and re-materialize on next access — DO storage is the expensive
tier, R2 the cheap one. Matters for the agent-created-repos fleet shape
(their explicit target, and ours).

**Skip — running upstream git.** Their biggest simplification (normal
git repos on NVMe, upstream git does the work) is unavailable on
workerd: no processes, no disk. Our Effect reimplementation is the cost
of running where we run.

**Note — S3 CAS revives the AWS-parity store story.** Continuity's
linearization is a compare-and-swap on an S3 object (`If-Match` /
`If-None-Match` conditional writes) — no DynamoDB, no consensus. That
replaces the RFC §6 assumption that AWS parity needs DynamoDB
transactions for ref CAS: a WAL-index CAS on S3 is sufficient, exactly
as Continuity demonstrates at 120–300 pushes/s (Standard vs Express One
Zone). The wire-plane hosting problem (Lambda's ~6 MB request cap)
remains the real blocker; the store problem is now solved on paper.

Benchmarks worth stealing: sustained small-push throughput per repo
(their 120–300/s number; ours is bounded by one DO — measure it), and
read-scaling under clone storm with the DO-less head-object path.

### §21.2 Push admission, and a bottleneck that wasn't

**Push admission is bounded by memory, not by count.** The Repo DO's
ingest semaphore existed for one reason (§2.1): two concurrent 50 MiB
buffers would exhaust a 128 MB isolate. It is *not* a correctness
device — a DO's input gate only closes across storage awaits, and
receive-pack awaits the network and blob storage, so pushes interleave
regardless; what makes that safe is `staged_push = pushId` scoping plus
a synchronous `transactionSync` finalize. Bounding the count therefore
made a kilobyte push wait out a 50 MiB upload for no reason. It now
reserves permits by buffered ceiling (`min(content-length,
MAX_PACK_BYTES)`, one permit per MiB, budget 64).

| small push (same repo) | latency |
| --- | --- |
| uncontended | 737 ms |
| while a 12 MiB upload is in flight | **802 ms** (+9%) |

Under the old single permit the second push waited for the first to
release, i.e. for the whole upload — by construction, not by measurement.

**What this does NOT fix:** concurrent pushes to *different branches*
still measure ~2.7/s, unchanged. Admission was never the ceiling there;
the DO is one JavaScript thread, so each push's inflate/SHA-1/SQL work
serializes whatever admission allows. Per-repo push throughput remains
the sharding problem of Part III.

**Stale clone bundles are not a bottleneck (measured, hypothesis
withdrawn).** The concern was that any ref moving after a bundle was cut
drops every clone onto a dynamic closure walk until the next re-cut.
Measured in one run against one repo, with the serving plane recorded on
`x-git-served-by` so neither arm can be mistaken for the other:

| clones, concurrency 32 | served by | rate |
| --- | --- | --- |
| fresh bundle | `do-bundle:bundle` | 40.4/s |
| stale bundle | `dynamic` | **35.9/s** |

An 11% cost, not the ~2x the earlier cross-run comparison suggested —
those "dynamic" figures came from requests carrying an unknown `have`,
which forces a *negotiation* walk, a strictly more expensive path than a
plain full clone with no usable bundle. Comparing across runs compared
two different things.

A bundle+delta splice was built and reverted. It is defeated by a
deliberate v1 tradeoff in `Store/Closure.ts`: boundary (common) commits'
tree/blob closures are **not** subtracted, so
`computeClosure(wants, haves = bundle refs)` returns a whole snapshot
rather than a delta. The spliced pack measured exactly 2x the bundle
(1.013 MiB vs 0.507 MiB) at 15.8 clones/s — worse than the dynamic path
it replaced. Making it work needs one of: the bundle recording its own
object set at cut time (`runBundleJob` already holds the manifest) so
the delta is a set subtraction rather than a walk; or protocol v2
`packfile-uris`, which is git's own answer — the client takes the bundle
by URI and runs an ordinary incremental fetch on top. Neither is worth
doing for 11%.

### §21.1 Implemented and measured

Both performance adoptions above are now implemented; measured on a
deployed stack (`test/GitBench.e2e.test.ts --profile testing`, SCALE=1,
same machine, before/after runs ~1 h apart).

**The head snapshot (DO-less anonymous reads).** The Repo DO rewrites a
tiny JSON object (`{repoId}/head`: refs, visibility, current bundle)
after every commit that changes what an anonymous reader can see; the
Worker serves the `info/refs` advertisement and bundle-covered full
clones straight from it. Engagement is proven, not inferred: responses
carry `x-git-served-by: head-snapshot` and the bench asserts it. The
Auth block still decides anonymous access (the Worker asks it with the
snapshot's repo context), a presented credential always goes to the DO,
and `startPurge` deletes the snapshot synchronously so deleted repos
stop serving immediately.

| anonymous reads on a public repo | before | after |
| --- | --- | --- |
| raw full clones, concurrency 32 | 69.4/s · 17.4 MiB/s | **101.0/s · 25.3 MiB/s** |
| same run, authed clones (DO path) | — | 48.1/s · 24.4 MiB/s |
| advertisements, concurrency 32 | 201.2/s | 206.5/s |
| advertisement, serial | — | 87 ms each |

The controlled comparison is the second row: in the same run, on the
same bytes, anonymous DO-less clones sustain **2.1× the throughput of
authed clones that plan through the DO** — cloud noise hits both
equally. The advertisement storm is flat because the *client* is the
bottleneck there (87 ms serial ≈ the bench machine's RTT; 32-way ≈
200/s is its ceiling): the assertion proves the DO left the path, but a
single-machine instrument cannot show the server-side headroom that
buys. The clone rows, which move real bytes, do.

**Geometric pack merging.** `Compact` now restores the geometric
invariant (factor 2) after each run: the smallest violating packs merge
by pure concatenation — our packs store non-delta entries, so a merge
is `header(Σcounts) + bodies + sha1` and one additive offset UPDATE per
source pack, no recompression. Unreferenced source packs grace-delete a
minute later (in-flight ranged reads finish first).

| dynamic fetch, repo compacted in 6 increments | before | after |
| --- | --- | --- |
| ms/fetch (serial ×8, 2.3 MiB pack) | 730 | **300–334** |

**2.2–2.4× faster** reads over the aged repo, reproduced across two
post-change runs. The push path is unchanged by both features (serial
push 1.3–1.5/s across all runs — the per-ref serialization floor §15
already names; that ceiling is v3's problem, not this change's).

## 22. The clone-throughput sweep

The complaint: clones pull 10–20 MB/s. The first question was whose
number that is, and the answer settles what to fix.

### §22.1 Diagnosis (production, `alchemy/alchemy`, 44k objects)

| measurement | value | meaning |
| --- | --- | --- |
| client ← Cloudflare edge, 50 MB static download | **67 MB/s** | the pipe is not the limit |
| bundle path, raw passthrough, 152 MiB | 10–21 MB/s (one sample stalled at 227 KB/s for 264 s) | **our streaming path is the limit** |
| bundle path, sideband | 10.5–17 MB/s | framing is not the difference; the variance is |
| dynamic path | 3.1 MB/s, TTFB 9.2 s | 44k sequential SQLite point reads |
| `info/refs` advertisement (2 refs) | **1.5 s** | per-request planning cost, paid twice per clone |
| repo object stats | loose=44,041 packed=0 r2=10, 152.7 MiB | **never compacted** — `COMPACT_COUNT_THRESHOLD` was 50,000 |
| bytes served vs bytes pushed | 152 MiB served, 70 MiB thin pack pushed | non-delta packs are 2.2x on the wire |

Three independent problems, in order of user impact: the Worker's bundle
streaming pipeline caps single-stream throughput far below the client's
pipe; every wire request pays ~1.5 s before its first byte; and the repo
was serving its fallback path from 44k un-packed SQLite rows.

### §22.2 Root causes

**Streaming (the throughput ceiling).** `serveBundle` piped R2's body
through `Stream.fromReadableStream` → `wrapSideband` (a `Stream.flatMap`
per chunk) → `HttpServerResponse.stream` → `toReadableStream`. Every
R2 chunk crossed an Effect fiber hand-off twice and was copied twice by
the sideband framer (`sidebandFrame` allocated a payload buffer, then
`pktLine` allocated again). At concurrency 4 the aggregate was only
1.5x a single stream — the isolate was CPU-bound on stream machinery,
not waiting on the network.

**TTFB.** `readMeta` ran `SELECT location, COUNT(*), SUM(zsize) FROM
objects GROUP BY location` on **every** request (via `requireMeta` at
the wire dispatch, inside `authorize`, and inside `writeHeadSnapshot`),
a full scan of a `WITHOUT ROWID` table whose leaf pages carry inline
zdata. Only the REST repo-detail response ever reads `meta.objects`.

**Dynamic path.** `packEntryStream` did one `sql.first` and ~6 Effect
stream nodes per object; the closure's tree walk did one SQL round trip
plus one inflate per tree, serially, before the first byte; and the
manifest order (commits → tags → trees → blobs) was uncorrelated with
compacted-pack layout (`ORDER BY oid`), so a 6-window LRU over a large
pack thrashed.

### §22.3 What changed

- **Native passthrough.** `ObjectBody`/`BlobBody` expose the store's
  own `ReadableStream` (`readable`); `respondWithPack` pipes it into the
  `Response` via `HttpServerResponse.raw`. Raw clones go through an
  `IdentityTransformStream` (workerd pipes it without JS touching the
  bytes); sideband clones go through `sidebandTransform`, a web
  `TransformStream` emitting a 5-byte header + a `subarray` per frame —
  no copy, no fiber per chunk. The Effect path remains as the fallback
  for stores without a native stream (S3).
- **`requireMeta` is config-only.** The objects aggregate is opt-in
  (`requireMetaStats`), paid by `getRepoMeta`/`updateRepoMeta` only.
- **Compaction thresholds** 50k objects / 1 GiB → **4k / 64 MiB**.
- **Batched emission and closure.** `ObjectStore.packEntries` reads
  objects 256 per statement, concatenates each batch into one chunk,
  and orders pack-resident objects by (pack, offset) so each 4 MiB
  window is fetched exactly once; `readContentBatch` + a level-order BFS
  read whole tree levels per statement. `packStream` uses the batched
  emitter whenever the source offers it.
- `sidebandFrame` builds its frame in one allocation (was two copies).

### §22.4 Measured (36 MiB / 15.6k-object repo, one client, same edge)

All numbers from `GitBench.e2e.test.ts` "single large clone", the same
client machine and edge for every row. "Before" is the row-storage,
Effect-stream code at the start of the sweep; the rest are cumulative.

| path (what real clients use) | before | native pump | +blob-only compaction | +pre-framed twin, per-window emitter |
| --- | --- | --- | --- | --- |
| raw bundle, 1 stream | 20.3 MiB/s | 41.0 | 37.9 | 40.9 (client line rate ≈ 40–70) |
| raw bundle, 4 streams (aggregate) | 29.7 MiB/s | 106.1 | 71.8 | 82.3 |
| **sideband bundle (every `git clone`)** | 15.5 MiB/s | 12.7–15.7 | 15.7 | **32.7** |
| dynamic fetch — TTFB | 1.4 s (rows) / 27.5 s (packed) | 12.0 s | **0.43 s** | 0.56 s |
| dynamic fetch — transfer | 6.2 MiB/s (rows) / 0.2 (packed) | 7.9 | 7.0 | 7.9 |

Run-to-run variance on the client link is large; the best verified run of
the final code (every pack de-framed and trailer-checked): raw 98.4 MiB/s
(0.56 s end to end), sideband **80.2 MiB/s** (0.69 s — a real `git clone`
of the 40 MiB repo), dynamic 9.8 MiB/s with 0.72 s TTFB, four concurrent
raw streams at 93 MiB/s aggregate. Before the sweep the same clone took
about 3 s.

What each step bought, and what it did not:

- **Native pump** (§22.3): the raw path went from an Effect stream to a
  platform `pipeTo` and doubled; four streams saturate the client link.
  It did NOT move sideband — three different framers (Effect stream,
  `TransformStream`, manual 1 MiB batched writes) all landed at ~15 MiB/s.
  The constant was never the framing: it is the cost of bundle bytes
  crossing into JS at all. Hence the **pre-framed twin**
  (`bundleSidebandKey`): the bundle job writes the pack a second time,
  already cut into 65515-byte band-1 frames, and sideband serving becomes
  a pure pipe plus a 4-byte flush. 2× on the path every real client uses,
  for 2× bundle storage.
- **Lowering the compaction thresholds** (50k → 4k objects) exposed a
  latent disaster: a fetch over pack storage took 27 s to start and 243 s
  to finish — the per-object emitter, in manifest order, missed the
  window cache on nearly every object (15.6k × 4 MiB window reads).
  Batching + (pack, offset) ordering fixed the transfer (0.2 → 7.9 MiB/s)
  but the tree walk still cost 12 s: trees are tiny and, packed in oid
  order, touch every window. **Blob-only compaction** removed the walk
  from R2 entirely — TTFB 12 s → 0.43 s — at the cost of keeping
  commits/trees/tags (a few percent of bytes) as SQLite rows.
- The dynamic transfer rate is now bounded by generation inside the DO
  (per-batch SQL + concat for resident objects, one window fetch per
  4 MiB of blobs), not by the response path; the per-window emitter and
  one-window lookahead did not move it. Clones do not take this path (the
  bundle covers them); incremental fetches are small. Left as the next
  target.

**Durability finding, same sweep.** A real `git push` of the 36 MiB
clone (a delta-heavy pack, unlike the snapshot the bench pushes) was
rejected: `Durable Object's isolate exceeded its memory limit and was
reset`, mid-`transactionSync`. The ingest's own footprint is bounded
(8 MiB staging batches, 20 MiB resolved-content LRU) — but the whole
pack sat in memory under the 50 MiB spill threshold, and instances of one
DO class share an isolate: the other repo's per-instance window cache and
its push gate were invisible to this push's accounting. Fixed by making
the window cache and the push-admission semaphore **isolate-wide**
(one 32 MiB LRU, one 64-permit gate) and lowering the in-memory spill
threshold to 24 MiB. The same push then succeeded with the first repo's
caches warm; the clone back through the DO was fsck-clean.

**Truncation finding, same sweep.** One bench run reported the dynamic
arm at 0.5 MiB of a 40.6 MiB pack — and passed. The compaction alarm
had moved rows to a pack between the closure (which recorded
`location='row'`) and emission (whose batched `SELECT oid, zdata` then
saw NULL); the emitter failed the stream, the bridge errored the
`ReadableStream`, the pump aborted the writable — and the client's HTTP
library read the aborted body as a clean end. Two fixes: the row emitter
now re-dispatches a moved object on its *current* location instead of
failing (compaction and fetches run concurrently by design), and every
timed clone in the bench de-frames the response and verifies the pack's
SHA-1 trailer, so bytes-received can never again stand in for a pack.
Real git was never at risk of a silent bad clone — it verifies the same
trailer — but it would have seen "unexpected EOF" on a fetch that raced a
compaction.

### §22.5 The push-ingest sweep

Measured with the platform's own per-invocation `cpuTime`/`wallTime`
(a `wrangler tail`), because workerd freezes `performance.now()` during
synchronous work — server-side timers only advance across awaits, which
is itself diagnostic but cannot attribute CPU. The 15.6k-object, 40 MiB
push of this repository, real `git push`, same edge:

| | push wall | DO cpu / wall | ingest | staging | finalize |
| --- | --- | --- | --- | --- | --- |
| start of sweep (in memory, per-row staging) | 63.6 s | — | 46 s | 3.1 s | 2.0 s |
| spilled reads as views, 64 KiB probe | 34 s | 10.0 / 34.9 s | 20 s | 6.6 s | 2.7 s |
| **promoted wire pack** | **24 s** | 8.3 / 16.0 s | 11–15 s | **0.4 s** | **0.7 s** |
| + synchronous per-entry fast path | 16–18 s | 7.2 / 16.9 s | 8.7–10.8 s | 0.3–0.6 s | 0.6–0.7 s |

What the numbers taught, in order:

1. **Production CPU is ~10x this laptop, uniformly.** A probe worker
   timing every per-object primitive (sync/streaming inflate, SHA-1,
   copies, a JS loop, Effect overhead, deflate) found nothing
   pathological — each is 8–15x slower there. Local ingest at
   0.14 ms/object *is* production ingest at ~1.5 ms. Every microsecond
   per object is worth ten. (`ZlibProbe.e2e.test.ts`; the local variant
   pins that workerd keeps the synchronous exact-span inflate.)
2. **The spilled reader copied 512 KiB per entry.** `blobRandomAccess`
   returned `slice()` for in-window reads and the parser probes each
   entry with a window-sized read: ~8 GB of memcpy per push, 31.9 s of
   CPU. Views fixed it (the in-memory reader always handed out views);
   the probe dropped to 64 KiB so crossing a window edge is rare and
   small, and the window grows to the header's declared size in one step.
3. **Durable Object storage cost is bytes WRITTEN, not statements.**
   Multi-row inserts and 8x larger batches did nothing on production
   (locally they halved staging time — commits are cheap there); finalize
   was 55 ms locally vs 4.9 s in production for the same 7.3k-object push.
   Staging writes every blob into SQLite; the staged→live flip rewrites
   every one of those records. Both are proportional to blob bytes.
4. **So don't write blobs to SQLite: promote the wire pack.** A push whose
   body spilled already holds every non-delta blob in exactly the
   compaction layout (typeSize header + zdata). Ingest now stages those
   rows as `location='pack'` references into the incoming object (pack id
   `wire-<receiveId>`, `packKeyOf` maps it), which then outlives the
   request as repo data. 9,633 of this push's 15.6k objects never touch a
   row; staging 6.6 s → 0.4 s, finalize 2.7 s → 0.7 s, and the later
   compaction rewrite of those blobs never happens. Delta-resolved blobs
   (fresh deflate, in no pack), trees, commits and tags still take rows.
5. **Spill early; merge rewrites wire packs.** With promotion the spilled
   path is the fast path, so the in-memory threshold is 4 MiB (a 5.7 MiB
   in-memory push spent 6 s in finalize; spilled, 2.2 s), and a spilled
   push's admission permit is its window working set, not its body. Wire
   packs also carry trees, commits and delta entries, so geometric merge
   *rewrites* them — copies only the referenced spans with regenerated
   headers and repoints each row — into a clean pack, then grace-deletes
   the wire object like any other source. Read fan-out stays geometric.

6. **A synchronous inner loop.** With sources exposing `readSync` (a
   view into the buffer or a cached window), a non-delta entry is decoded,
   inflated, hashed and copied with no fiber hop, and entries reach the
   staging sink 256 at a time. 13% of production ingest CPU; workerd's
   `_processChunk` closes its binding after one chunk, so an inflate
   engine cannot be reused there (probed and recorded).

Where this leaves a 40 MiB push: about 6.7 s is the client (git's own
pack build plus the upload; GitHub pays the same), ~7 s is the server's
per-object verification CPU on a core roughly 10x slower than a laptop's,
and ~1 s is staging plus finalize. The verification is what git requires
to trust a pack — every entry inflated and hashed before any ref moves —
and it runs single-threaded in the repo's Durable Object. Going meaningfully
below this means parallelizing that verification across isolates (a pack
has no index, so boundaries are only known by inflating; hashing could be
fanned out but is under half the work) or changing what the client sends.

Left: the remaining ingest CPU (inflate + SHA-1 + parse, ~7 s here) is
the work git itself requires to trust a pack; finalize's residual is the
flip of the delta-resolved rows. Both scale with object count, not bytes.

### §22.6 Streaming ingest

The push body was received whole (in memory below the threshold, spilled
to blob storage above it) and only then parsed. Two serial phases, each
as long as the other; and a 128 MB isolate that can hold exactly one
large body. Ingest now parses the body **while it arrives**:

- `StreamingSource` (`Store/StreamingSource.ts`) is a `RandomAccess` over
  4 MiB slabs the receiver fills. A read past what has arrived waits;
  a read behind the retention window (16 MiB) is served from the spilled
  object once the body has ended — and fails if it never spills, so a
  parser that needs an evicted base defers that entry to a pass after
  `awaitEnd` (`BaseEvictedError`). The feeder parks when it is 24 MiB
  ahead of the parser, and a waiting reader always releases a parked
  feeder: the two never deadlock on each other.
- `receiveWireBodyStreaming` feeds the source and, past the threshold,
  uploads uniform 8 MiB parts concurrently (three in flight) so no
  round trip to blob storage stalls the request body. The part list is
  completed in part-number order regardless of settle order
  (`orderedMultipart`) — R2 validates the uniform-part rule against the
  list as given, and the tail settles before earlier parts do.
- The parser tolerates an unknown pack length: the entry loop is driven
  by the header's count, the trailer SHA-1 is fed incrementally with a
  20-byte lag, and the trailer is compared once the source ends.

The head of the body (the pkt-line commands) is read as a 1 MiB range
before anything else; a delete-only push is a 12-byte probe that fails.

### §22.7 The hasher fan-out

Verification is what git requires to trust a pack: every entry inflated
and hashed before any ref moves. It scales with object count, and on a
core ~10x slower than a laptop it was the bulk of a 40 MiB push. It is
now a service — `Hasher` (`Hasher/Hasher.ts`) — with two layers:
`HasherInline` (the same isolate) and `HasherSelf`, which POSTs pack
parts to `/_alchemy/git/hash` on the Worker's own `Self` binding, so a
push is verified by as many isolates as it has parts. The route is
admin-authenticated (the Worker's own key) and answers a compact binary
result: entry coordinates, oids, and for delta-resolved entries the fresh
zlib bytes; non-delta entries ship no bytes (their rows are promoted
coordinates or are read back from the source).

### §22.8 Raw chunks, resync, stitching

A pack has no index: entry boundaries are only known by inflating. The
first fan-out shipped each part with the previous part's incomplete tail,
which made the dispatch a serial chain gated on each part's result — the
fan-out degenerated to one hasher at a time. Two passes (a cheap
boundary pre-scan in the DO, then hashing by known spans) moved the CPU
back into the single-threaded object.

The pump now dispatches **raw 4 MiB chunks as they arrive**, four in
flight, with no dependency between them. Every chunk but the first is
scanned in *resync* mode (`PartialScan.ts`): `findBoundary` walks the
chunk for a zlib header (`0x78` + one of the four FLG bytes) at which two
consecutive entries parse, and the scan proceeds from there — lenient,
because `remaining` is only an upper bound and the last chunk runs into
the trailer. The DO then consumes results in chunk order: the bytes
between the last settled boundary and a chunk's first found boundary —
one straddling entry, normally — are scanned as a region from the
retained payloads; a region that ends exactly at the found boundary
confirms the resync, otherwise the chunk is rescanned sequentially from
the settled boundary. Chunks too small to hold two entries report no
boundary and are settled by a later region. Deltas whose base lies in
another chunk come back unresolved and are applied after the trailer,
against bases from any chunk or from the live store.

The platform's own timeline (a `wrangler tail` of the hash calls) showed
the fan-out working and the push still slow: chunks 0–3 arrived within
0.7 s and the rest dribbled in at ~4 MiB/s, while the receive-pack
invocation's wall time was five times its CPU. Everything the Durable
Object received it also sent out twice — to the spill and to the hashers.

### §22.9 The pack never enters the Durable Object

The whole pipeline above now runs in the **stateless Worker**
(`Server.ts` `receivePackRoute`): it receives the body, verifies it
through the fan-out, stitches, resolves deltas, and ships the Repo DO only
*rows* over RPC — `beginPush` (authorization of the parsed commands, the
staging push row), `stagePush` (batches of staged rows, three in flight
and joined before the commit; promoted rows are coordinates into the wire
pack, inline rows carry their zlib bytes — `PushWire.ts`), `readPushBase`
(thin-delta bases), and `commitPush` (connectivity over the staged rows,
the commit graph, the transactional ref CAS, post-commit bookkeeping).
The DO's memory, CPU and egress are untouched by push size; its part of
a push is SQL.

Moving the pipeline exposed the next wall: the receiver was sending
every byte out twice — to the spill and to the hashers — and the last
part was dispatched only when the multipart upload completed, because
that was when the streaming source ended. Three changes:

- **The hasher writes the spill.** Parts are body-aligned 8 MiB (R2's
  uniform-part rule), and each `hashPart` call carries the multipart
  upload's key and id: the hasher isolate writes the part it verifies
  (`BlobStoreShape.uploadPart` — parts may be uploaded from any isolate;
  `complete` takes the collected parts and sorts them). The receiver
  sends each byte out once; the first part carries the command section
  and the pack header before its first entry (`skip`).
- **The source ends at body end.** `expectFallback` makes an evicted read
  wait for the completed spill instead of failing, so the last part is
  dispatched the moment the body ends, and results settle while the body
  is still arriving: the consumer is a forked fiber, the producer runs
  on the request's own (hash fibers are its children).
- **The straddler is speculative.** The entry crossing a part edge is
  dispatched the moment its part settles, sized from its own header out
  of the retained bytes, so a 10 MB blob spanning three parts is hashed
  alongside the parts rather than after the last one — and `findBoundary`
  searches the whole part (it searched the first MiB: a part whose head
  lay inside such a blob reported no boundary and was hashed serially).

What is left is the Worker's own I/O: a single invocation receives the
body and forwards it, and the two share the isolate's throughput.

### §22.10 Measured, and the wall

The same two pushes as §22.5 — this repository's 15.6k-object, 40 MiB
delta-heavy pack (`loose`) and a 15.3k-object, 44 MiB pack of mostly
whole blobs (`synthetic`) — real `git push` from the same client, same
edge, and GitHub on a fresh repository from the same client for scale.
Cloudflare timings vary run to run by ±20%; the ranges are what was seen.

| | loose push | synthetic push | incremental push | bare clone |
| --- | --- | --- | --- | --- |
| GitHub (fresh repo) | 3.3 s | 4.6 s | 1.2 s | 1.3 / 2.1 s |
| start of this sweep (in-DO, sequential fan-out) | 16 s | 10.8 s | 0.9–1.3 s | 1.3 s |
| pipeline in the Worker (§22.9) | 19 s | 12.9 s | | |
| + hashers write the spill, body-aligned parts | 14–19 s | 9.3–12.9 s | | |
| + speculative straddler, whole-part boundary search | 11.3–14.8 s | 7.7 s | 0.3–0.4 s | |
| + scan-first hash responses, native receive loop | 13–14.6 s | 9.5–11 s | 0.3–0.7 s | 1.3 s |
| **`HasherInline`** (no fan-out; the reference assembly) | 9.9–13.5 s | 8.8 s | 0.24–0.27 s | 1.3 s |

The receive-side phases of a loose push at the end of the sweep (from
the pump's own log, `Date.now` advancing only across I/O): parts 1–3
arrive within 1.3 s (18 MiB/s, the client's rate to Cloudflare's own
speed test), then nothing arrives for 4.5 s while three hash calls are in
flight, then the rest; the body ends at 8.7 s and the last result settles
at 8.7 s. The hash calls' wall times stack instead of overlapping.

**Why: service-binding subrequests run on the caller's thread.** A probe
route fanning one 8 MiB part out N times, timed from the client:

| transport | n=1 | n=3 | n=6 |
| --- | --- | --- | --- |
| self service binding (`Cloudflare.Workers.Self`) | 1.1 s | 1.9–2.6 s | 3.9–4.5 s |
| service binding to a second script | 0.7–1.0 s | 1.4–2.5 s | 3.6–3.9 s |
| `fetch` to the Worker's own workers.dev URL | refused (connection lost) |
| `fetch` to a second script's workers.dev URL | refused (connection lost) |

Six calls cost six times one call over both bindings: the callee executes
in the caller's isolate (four concurrent self calls with 8 MiB bodies hit
the isolate's memory limit, error 1102), and the in-Worker clock does not
even advance across the call. The fan-out therefore never parallelized
CPU; it moved bytes around on one thread. What it did buy — and what the
Worker-side pipeline keeps — is a Durable Object that never sees a pack
byte, a receive that is not blocked on the spill, and hashing that
overlaps the client's upload as well as one thread allows.

Requests arriving from OUTSIDE are spread across isolates: four
concurrent external calls of the same part finished as two pairs (2.0 s
and 4.1 s), i.e. two-way parallelism. Cross-zone `fetch` to a hasher on
another zone would inherit that, at the price of real network egress
competing with the client's upload.

On one thread the floor for a push is roughly `max(ingress, hash CPU)`
plus staging and commit: for the loose pack about 2.5 s of upload and 5 s
of hashing on a core ~10x slower than a laptop's, so 6–7 s before the
commit — the measured 8.7–11 s is that floor plus imperfect overlap. The
synthetic pack hashes in ~2 s and lands nearer 6 s. Reaching GitHub's
3.3 s on the delta-heavy pack needs compute Workers do not offer per
request: native `index-pack` in a Container (verifying 40 MiB in well
under a second, writing R2 from its own network), or a multi-core host
behind a cross-zone HTTP hasher. Both are layers this design admits
(`Hasher` is a service); neither is built here.

With the fan-out removed (`HasherInline`, the receiver hashing as parts
arrive and spilling them itself), the loose push measures 9.9–13.5 s and
the receiver's own CPU shows the hashing — 5.0–7.9 s of it — that the
fan-out had spread over invocations on the same thread. That layer is now
the reference assembly; `HasherSelf` stays as the shape a remote hasher
takes.

Where the pipeline is already at or past parity: incremental pushes
(0.24–0.7 s vs 1.2 s), bare clones (§22.4), and the read path.

### §22.11 Hasher layers: the same push on other compute

`Hasher` is a service precisely so the compute behind verification can be
chosen per deployment. Three layers ship:

| layer | where the scan runs | spill parts written by | parallelism | cost model |
| --- | --- | --- | --- | --- |
| `HasherInline` (default) | the receiving Worker | the receiver | none (one thread) | included in the Worker's CPU |
| `HasherSelf` | another invocation of the same script | the hasher | none on Cloudflare (§22.10) | same |
| `HasherLambda(fn)` (`alchemy/Git/Hasher`) | an AWS Lambda per chunk | the receiver | one Lambda per 4 MiB chunk, all at once | Lambda-seconds + cross-cloud egress |

**`HasherLambda`.** The Git Worker binds `AWS.Lambda.InvokeFunction` on a
Lambda declared in the same stack (`HasherFunction`, an Effect-native
Function whose only handler answers hash events); the stack carries both
provider sets. Binding a Lambda operation to a *Worker* host provisions —
once per Worker — an IAM user, key and least-privilege assume-role Role,
binds the key and role ARN onto the Worker, and signs each invoke with
credentials assumed through a single-flight, expiry-aware resolver: the
cross-cloud scaffolding the MicroVM bindings introduced, now shared by
every function-scoped Lambda `*Http` binding (`BindingHttp.ts`).

The invoke payload is JSON, so a chunk travels base64: chunks are 4 MiB
(≈5.6 MB encoded, under the 6 MB limit) — the pump reads chunks of the
hasher's declared size and, because a Lambda cannot reach the blob store,
uploads the 8 MiB spill parts itself from the retained bytes
(`writesSpill: false`). The response is bounded to the same limit: the
Lambda omits non-blob content (the receiver inflates trees and commits
from its retained bytes) and, when the fresh zdata of delta-resolved
entries would still overflow, demotes the largest of them back to
`unresolved` with their base references, so the receiver resolves those
as it would any cross-chunk delta. Any failure on the Lambda side — a
throttle, a cold-start timeout, a rejected payload — hashes that chunk
inline: a push never fails because its hasher did.

Measured, same pushes and client as §22.10 (`HasherLambda`, `us-east-1`,
3 GB functions, the Worker on Cloudflare's edge):

| | loose push | synthetic push | incremental push |
| --- | --- | --- | --- |
| GitHub (fresh repo) | 3.3 s | 4.6 s | 1.2 s |
| `HasherInline` | 9.9–13.5 s | 8.8 s | 0.24–0.4 s |
| **`HasherLambda`** | **6.8–7.9 s** | **6.3–6.7 s** | 0.27–0.8 s |

The body now arrives in 0.8–2.7 s (the receiver's thread is free), the
last chunk settles within a second of it, and the receiver's own CPU
drops to 1.4–2.7 s: the trailer SHA-1, the staging batches, and — on the
delta-heavy pack — 515 cross-chunk deltas resolved locally plus the
10 MB straddler that exceeds an invoke payload and is hashed inline.
Those, the staging round trips (0.7–1.2 s) and the commit (0.6–0.7 s)
are what remains between this and GitHub.

What this buys: every chunk verifies at once, on a core several times
faster than a Worker's, so hashing leaves the receive's critical path;
what it costs: the chunk crosses to AWS and the scan comes back, so a
Lambda hasher is worth it for pushes of tens of MiB and irrelevant for the
kilobyte pushes that dominate a repository's life — which is why it is a
layer and not the default.

### §22.12 Hasher on dynamically loaded Workers

`WorkerLoader` instantiates a Worker from module source at runtime, under
a name the runtime caches. The question that decides whether it is a
hasher was answered by a probe (four loaded workers each running a fixed
CPU burn, timed from the client):

| | n=1 | n=4 same name | n=4 distinct names | n=8 |
| --- | --- | --- | --- | --- |
| CPU burn, client time | 0.44–0.79 s | 1.94 s (serial) | **0.65 s (parallel)** | refused |
| 100 MB allocation each | ok | ok | ok, four isolates at once | refused |

Distinct names are distinct isolates, and distinct isolates run **in
parallel with the caller** — unlike a service binding (§22.10). Each has
its own 128 MB. The runtime allows four concurrent dynamic-worker
invocations per request; an eighth call fails with "Dynamic worker
concurrency limit exceeded".

`HasherWorkerLoader` (`alchemy/Git/Hasher`) keeps four fixed names
(`git-hasher-0..3`, warm across pushes), dispatches 4 MiB chunks over the
hash route's own protocol, and lets the pump write the spill
(`writesSpill: false`); the loaded hasher has no bindings and
`globalOutbound: null`. Its module is the real scanner: the Worker
bundler gained a `?worker` import (`WorkerModulePlugin.ts`) that bundles
the target into one self-contained module and imports it as a string —
nested `?worker` imports included — so `WorkerLoaderModule.ts` is ordinary
TypeScript that shares `PartialScan` with everything else. (The loader's
`get` also wrapped the native stub as an entrypoint and had no `fetch`;
fixed with a regression test.)

Measured, same pushes and client as §22.10:

| | loose push | synthetic push | incremental push |
| --- | --- | --- | --- |
| GitHub (fresh repo) | 3.3 s | 4.6 s | 1.2 s |
| `HasherInline` | 9.9–13.5 s | 8.8 s | 0.24–0.4 s |
| `HasherLambda` | 6.8–7.9 s | 6.3–6.7 s | 0.27–0.8 s |
| **`HasherWorkerLoader`** | **7.1–7.8 s** | **6.8 s** | 0.24 s |

The body is in by 0.8–1.5 s, chunks settle in waves of four (four by
0.9 s, the next four by 2.1 s, the last by 2.5 s), and the receiver's own
CPU is the lowest of the three (0.9–1.4 s: no base64, no signing). What
remains is the same tail as §22.11 — cross-chunk deltas, the oversize
straddler, staging and the commit — and the four-way cap: a push wider
than four chunks hashes in waves.

### §22.13 Deltas as jobs, and the resolved pack

Two receiver-side costs survived every hasher: the cross-chunk and thin
deltas the scan leaves unresolved (515 on the delta-heavy pack) were
applied, hashed and deflated on the receiver's thread, and every
delta-resolved blob was staged inline — its fresh zlib written into
SQLite and rewritten by the staged→live flip.

**Delta rounds.** `Hasher.resolveDeltas(bases, jobs)` applies a batch of
deltas whose bases the caller supplies (a base's zlib or, for a live
object, its content), returning oid, fresh zlib and non-blob content.
The pump resolves in rounds: every delta whose base is known joins a
byte-bounded batch — bases shipped once per batch — and the batches run
across the hasher's slots at once; a delta on a still-unresolved delta
waits for the next round. The receiver only assembles bytes it already
holds. Every layer implements it (the loaded worker and the self route
answer `mode=deltas`; the Lambda keeps it inline until its payload budget
is worth spending). 515 deltas: 0.26–0.37 s of round trips instead of
receiver CPU.

**The resolved pack.** While a body spills, delta-resolved blobs are held
back from staging; after the rounds their zlib is written as one object,
`wire-<receiveId>-r` (`typeSize header + zdata` per entry, the promoted
layout `packKeyOf` already maps), and their rows become coordinates. The
DO writes no blob bytes for a large push at all: on the delta-heavy pack
every one of its 13,646 blobs is a coordinate and 1,968 trees, commits
and tags stay resident (the resolved pack is 4.1 MB). Compaction's
geometric merge treats it like any wire pack.

### §22.14 The lazy flip

With every blob a coordinate, `finalize` was still 0.6–0.7 s of a
~4.3 s push: `UPDATE objects SET staged_push = NULL WHERE staged_push = ?`
rewrites every staged row of a WITHOUT ROWID table keyed by random oids —
one page per row, on the response path. A staging table would only move
the same random-page insert to commit time.

A push's objects are now live the moment its `pushes` row is committed:
every read predicate is `LIVE_OBJECTS` —
`staged_push IS NULL OR staged_push IN (committed pushes)` — a
materialized subquery over a table that holds at most the pushes whose
flip is pending. The transaction commits the refs, the graph and the
push row; the per-row rewrite runs after the response (`flipPush`, in
the DO's `waitUntil`), and GC flips any committed push whose deferred
flip never ran. A new push may adopt rows only from pushes that are not
committed, so a committed-unflipped row is never re-staged (and then
GC'd) out from under a live object. Finalize on the delta-heavy push:
0.7 s → the refs and graph alone; locally 50 ms → 2 ms.

### §22.15 Where the sweep stands

Same pushes and client; three runs each on the loader hasher after
§22.13–14, best and median (the spread is the client's uplink — the
route's own total is 3.4–3.9 s for the loose push and 2.2–3.6 s for the
synthetic one):

| | loose push | synthetic push |
| --- | --- | --- |
| GitHub (fresh repo) | 3.3 s | 4.6 s |
| start of the sweep | 63.6 s | — |
| `HasherWorkerLoader`, §22.12 | 7.1–7.8 s | 6.8 s |
| + delta jobs, resolved pack, lazy flip, batched graph, edge-only connectivity | **5.9 s best, 6.5 s median** | **4.8 s best, 6.4 s median** |

The whole-blob push meets GitHub on a good run. The delta-heavy push is
2.6 s behind on its best run, and the route's remaining time is the
hashing waves — ten 4 MiB chunks over four isolates, the third wave
landing a second after the body — plus the delta rounds (0.2–0.4 s),
the resolved pack's late write and the commit round trip (0.5–0.7 s).
The next lever for it is more than four hashers per push: a loaded
hasher can hold a loader binding of its own and fan a chunk out a
second time, or a push can split its chunks across the loader and a
Lambda. Neither is built here.
