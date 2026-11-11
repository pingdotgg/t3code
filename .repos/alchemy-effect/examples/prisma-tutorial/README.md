# Prisma tutorial

The complete application from the [four-part Prisma tutorial](https://alchemy.run/prisma/tutorial/part-1): a shared Project, Effect-native Compute API, Postgres connection, and Vite frontend.

## Run

From the repository root, install dependencies with `pnpm install`. Then:

```sh
cd examples/prisma-tutorial
bun alchemy profile edit --add Prisma
bun run deploy
```

Open the returned website URL and click **Read database time**. The API executes `SELECT current_timestamp::text AS time` against Prisma Postgres; no schema setup is needed.

```sh
bun run dev
```

The frontend runs locally in Vite. The API, its database, and the shared Project remain remote because the Stack explicitly uses `Alchemy.remote()`. Credentials and cloud charges still apply. A separate `--stage dev` creates a separate remote backend rather than using another stage's database.

## Test

```sh
ALCHEMY_PROFILE=testing timeout 240 bun test
```

The test deploys the real application, queries Postgres over HTTP, checks CORS and error routes, and destroys the Stack afterward. Set `NO_DESTROY=1` only when retaining the deployment for manual browser verification.

## Cleanup

```sh
bun run destroy
```

Use the profile and stage used for deployment. For retained test deployments, pass the test harness's stage with `--stage`; this is separate from the normal deploy stage. Retain `.alchemy/` until cleanup finishes.

The API deliberately exposes only a read-only database timestamp and allows all origins. Restrict origins and add authentication before exposing private data. Only the public API URL goes into `VITE_API_URL`; database credentials stay in the Compute binding.
