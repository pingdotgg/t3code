# effect-http-ws-cli (PoC)

Minimal PoC using Effect v4 beta with a single unified program:

- `effect/unstable/cli` as the app entrypoint
- `effect/unstable/http` (`HttpServer`, `HttpRouter`, `HttpServerRequest`, `HttpServerResponse`) for server/runtime logic
- `@effect/platform-node` to host the server on Node.js
- HTTP + WebSocket message routing based on `effect/Schema` validation
- static asset serving from local filesystem (`public/` by default)

The repo now uses a Bun workspace:

- `server/` contains the Effect HTTP + WebSocket backend
- `web/` remains the Vite + React frontend package

## Run

```bash
bun install
bun run web:build
bun run start -- --port 8787 --host 127.0.0.1 --assets public --db todo.sqlite
```

Then open `http://127.0.0.1:8787`.

## Frontend

React + Vite client lives in `web/` and is built into `public/` so it is served by the static router.

```bash
bun run web:build
```

For local development without building the frontend:

```bash
bun run dev
```

That starts the backend, starts Vite on `http://127.0.0.1:5173`, and redirects frontend page requests there. In dev, Vite proxies `/api/*`, `/ws`, and `/health` back to the backend server.

If you want to run the processes separately, start `bun run web:dev` and launch the backend with `FRONTEND_DEV_ORIGIN=http://127.0.0.1:5173`.

The UI now demonstrates a typed realtime todo workflow:

- load todo snapshot on page load (`listTodos`)
- subscribe to todo updates (`subscribeTodos`)
- mutate todos via RPC (`renameTodo`, `completeTodo`, `archiveTodo`)

### Config Sources

Config is resolved from both CLI flags and `effect/Config`:

- CLI flags: `--host`, `--port`, `--assets`, `--db`, `--request-logging`, `--frontend-dev-origin`
- Env via `effect/Config`: `HOST`, `PORT`, `ASSETS_DIR`, `DB_FILENAME`, `REQUEST_LOGGING`, `FRONTEND_DEV_ORIGIN`

Precedence:

1. CLI flags
2. `effect/Config` (environment)
3. hard defaults (`127.0.0.1`, `8787`, `public`, `todo.sqlite`)

### SQL Persistence

- Uses `effect/unstable/sql` + `SqlSchema` for typed SQL request/result decoding.
- Uses `@effect/sql-sqlite-node` as the Node runtime SQL client.
- Database schema is managed by `effect/unstable/sql/Migrator` via `server/src/migrations.ts` with statically imported migration files.

## API

- `GET /health`
- `POST /api/dispatch`
- `GET /ws` (WebSocket RPC)
- `GET *` (static files)

### Message schema

Incoming messages are validated with `Schema`:

- `{ "kind": "echo", "text": string }`
- `{ "kind": "sum", "left": number, "right": number }`
- `{ "kind": "time" }`

Both HTTP and WebSocket dispatch use the same schema-driven router.

## Verify

```bash
bun run test
bun run test:web
bun run lint
```
