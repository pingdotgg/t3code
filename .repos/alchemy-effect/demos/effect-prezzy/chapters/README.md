# Shorty, chapter by chapter

Each folder is the complete app at the end of one chapter of the talk
(see `../CONTENT.md`). Consecutive folders differ by exactly that
chapter's change, so the recording types the diff between them.

| Chapter | What it adds |
| --- | --- |
| `00-website` | `Cloudflare.Website.Vite` dashboard shell |
| `01-api` | Effectful Worker serving an `HttpApi`; typed client in the dashboard |
| `02-d1` | D1 database with migrations; redirects |
| `03-tests` | `test/api.test.ts`: deploy → assert → destroy |
| `04-durable-objects` | `LinkRoom` Durable Object, hibernatable WebSockets, live counts |
| `05-queues` | `Clicks` queue: redirects enqueue, a consumer counts in batches |
| `06-layers-neon` | `Links` service + `LinksSql`; storage Layers for D1 and Neon via Hyperdrive |
| `07-telemetry` | Spans, Axiom datasets and ingest token, `Axiom.Telemetry` |
| `08-dashboard` | `Axiom.Dashboard` as code |

Run a chapter from its folder, with the demo's binaries on `PATH`:

```sh
export PATH="$PWD/../../node_modules/.bin:$PATH" ALCHEMY_PROFILE=testing
alchemy dev    # API on localhost:1337, dashboard on localhost:5173
pnpm test      # deploys test_$USER, runs the tests, destroys it
```

Dependencies come from `demos/effect-prezzy/package.json`. Type-check a
chapter from the repo root with `pnpm exec tsc -b demos/effect-prezzy/chapters/<folder>`.
