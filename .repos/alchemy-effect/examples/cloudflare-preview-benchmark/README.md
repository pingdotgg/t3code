# cloudflare-preview-benchmark

The app behind the PR-lifecycle animation on the alchemy.run landing page: an R2 bucket (`Photos`), a KV namespace (`Sessions`), and an Effect-native Worker (`Api`) bound to both. It is deployed per pull request as a preview stage, tested over HTTP, and destroyed.

| Route | Behavior |
| --- | --- |
| `GET /photos` | JSON gallery listing every object key in `Photos` |
| `PUT /photos/:key` | Uploads the request body to `Photos` |
| `GET /session` | Starts a session and stores it in `Sessions`; with an `x-session-id` header, reads it back |

This example creates billable Cloudflare infrastructure. Destroy it when you are done.

## Run it

```sh
bun alchemy deploy --stage pr-147
STAGE=pr-147 bun test
bun alchemy destroy --stage pr-147
```

`test/preview.test.ts` deploys through the Alchemy test harness in `beforeAll`. That deploy is a no-op when the stage already exists. Without `STAGE`, the harness uses its default stage, `test_$USER`. The stack is destroyed after the tests only when `CI` is set.

`Photos` sets `forceDestroy: true` because the upload test leaves an object in the bucket, and R2 refuses to delete a non-empty bucket.

## Benchmark

The "full picture" animation on the landing page (`website/src/components/marketing-islands/PRLifecycle.tsx`) replays these timings in real time for the deploy, test and destroy logs. Re-run the benchmark when Alchemy gets faster or slower, and update the `T_*` constants at the top of that file to match.

### Run it

You need a Cloudflare account and an Alchemy profile with credentials for it (`bunx alchemy login --profile <name>` creates one).

```sh
# from the repo root, once
pnpm install

cd examples/cloudflare-preview-benchmark
ALCHEMY_PROFILE=<name> bun run bench
```

`bun run bench` runs `scripts/bench.sh`, which times one full preview lifecycle and prints one line per phase:

```
deploy   11.62s
url live 0.41s  https://api-….workers.dev
test     4.53s
destroy  3.80s
total    20.36s  (logs: .alchemy/bench/<timestamp>-*.log)
```

- `STAGE` picks the stage name (default `pr-147`). Use a unique one if several people share an account.
- Each phase's full CLI output is written to `.alchemy/bench/`. The per-resource breakdown below comes from the deploy and destroy logs.
- The script always destroys the stage at the end. If it fails midway, clean up with `bunx alchemy destroy --stage <stage>`.
- Run it three times and take the median; the first run after an install is slower while Bun warms its cache.

### Results

Median of three full cycles, wall clock:

| Phase | Time |
| --- | --- |
| **Deploy (create 3 resources)** | **11.6s** |
| · CLI startup, stack import, state load | 1.2s |
| · plan | 1.3s |
| · `Sessions` created | 0.7s |
| · `Photos` created | 3.6s |
| · `Api` created (waits for `Photos`, bundles 2.2s, uploads and enables workers.dev 3.3s) | 9.4s |
| **Worker URL returns 200 after deploy** | **+0.4s** |
| **Tests, plain `fetch` against the URL** | **0.7s** |
| **Tests, through the Alchemy harness (`bun test`)** | **4.5s** |
| · GET /photos renders the gallery | 0.24s |
| · uploads a photo to R2 | 0.28s |
| · session survives a reload | 0.26s |
| **Deploy with no changes** | **4.0s** |
| **Deploy after a one-line Worker change** | **7.6s** |
| · new code served at the URL | +0.2s |
| **Destroy** | **3.8s** |
| · `Api` deleted | 0.7s |
| · `Photos` emptied and deleted | 1.4s |
| · `Sessions` deleted | 0.4s |

Most of the harness test time is the no-op deploy in `beforeAll`: it re-reads every resource from Cloudflare (about 3.2s). The same three tests take 0.7s without it. Running the CLI under Node instead of Bun added about 0.7s per command.

These numbers come from one Linux machine and one Cloudflare account, using alchemy 2.0.0-beta.79, effect 4.0.0-rc.117 and Bun 1.3.13. Treat them as indicative.

The landing-page animation also shows a `GitHub.Comment` posting the preview URL. It is not part of this example or the benchmark because it needs a GitHub token and a target PR.
