# Railway GraphQL migration verification

The providers use `@distilled.cloud/railway`. Every object operation
supplies its required projection. Shared selections describe resource
attributes; reconcile selections add only fields needed for decisions.
Nested connection helpers in `src/Railway/GraphQL.ts` paginate all results
and reject repeated cursors. Service listing walks actual environment service
instances instead of probing every service/environment combination.

The SDK's [client guide](../../../../submodules/distilled/packages/railway/README.md)
describes selection composition, typed aggregate errors, report mode, and
retry behavior. Its [patch evidence](../../../../submodules/distilled/packages/railway/patches/graphql/README.md)
records observed wire errors and the contracts generated from them.

## Run isolated live tests

Use a dedicated project and stage when another worktree might be testing
Railway. The final component of the project name must follow Alchemy's
physical-name suffix rules; `graphqltest` is a valid suffix.

```sh
timeout -k 5 240 doppler run --project alchemy-v2 --config dev -- \
  env ALCHEMY_TEST_STAGE=test_graphql_f9c5 \
  RAILWAY_TEST_PROJECT_NAME=alchsuite-graphqltest \
  pnpm test test/Railway/Postgres.test.ts \
    --profile testing --retry 0 --concurrency 1
```

Tests own separate environments within the project. Use bounded batches;
the command's deadline is a failure, not a reason to repeat it blindly.
Credentials come from the configured profile/environment and never belong
in test output or fixtures. The dedicated project can be removed after all
of its tests finish; do not remove another worktree's shared suite project.

## Live flywheel findings

Verified during the September 12, 2026 migration:

The run records 52 distinct passing live Railway checks. After standardizing
deletion confirmation, the final affected batches pass 17 lifecycle checks
(two documented gates) and all three database CRUD checks again.

- Project, environment, variable, group, service, domain, TCP proxy, usage,
  login session, audit log, cloud agent, and sandbox test paths use selective
  operations. Entitlement probes retain exact tagged failures.
- Bucket CRUD and S3 object round trips pass. Credential creation can lag
  bucket creation; its exact observed failure is patched and readiness is
  bounded.
- Private-network CRUD/rename and template deployment/list/delete regressions
  are enabled and pass. Network identifiers accept the actual BigInt wire
  representation. Inaccessible template metadata stays optional.
- Mongo, MySQL, Postgres, and Redis CRUD, query/ping, update, listing, and
  deletion pass. Mongo and MySQL deployed Service integrations pass.
  Postgres's deployed Service and Function SQL integrations pass. The MySQL
  fixture uses an exact dependency record to avoid ambiguous lockfile versions.
- Function canvas lifecycle and async HTTP lifecycle pass. Owned services
  are deleted globally; deleting only an environment instance and waiting
  for the whole service to disappear was an incorrect convergence check.
- Redis and bucket bindings pass deployed runtime round trips.
- CDN create/update/disable passes direct selective read-back assertions.
  It waits for a public domain to be ready and sends Railway's lowercase
  HTML-caching values. A pathless generic failure is classified without
  inventing a field-specific cause or an entitlement restriction.
- Thirteen website/CDN cases pass: Astro, CDN, Next.js, Nuxt,
  Octane, React Router, SolidStart, StaticSite, SvelteKit, TanStack Start,
  Vite, Vocs, and Waku. This covers deployment, HTTP serving, and deletion;
  the dedicated CDN case also checks update and disablement.

The Postgres runtime check also exposed a shared SQL-driver compatibility
issue: Railway URLs use `sslmode=no-verify`, which Effect's parser rejects.
`SQL/PostgresTls.ts` normalizes the URL and explicit TLS options together,
preserving caller overrides and redacted credentials. SNI is now handled by
the upstream driver. A parser-level local
regression covers this without opening a network connection.

## Local verification

```sh
bun test submodules/distilled/packages/core/src/graphql.test.ts \
  submodules/distilled/packages/core/src/codegen/graphql-client.test.ts \
  submodules/distilled/packages/railway/test/graphql.test.ts
pnpm exec tsc -b
timeout -k 5 240 pnpm test test/SQL/PostgresTls.test.ts --profile testing
timeout -k 5 60 pnpm test test/Railway/GraphQL.local.test.ts --retry 0 --sequential
pnpm docs:gen
pnpm docs:check-jsdoc
```

The GraphQL suites cover selected result/error types, aliases, fragments,
partial responses, multiple simultaneous errors, null propagation, variables,
pagination, scalar validation, generated symbol collisions, and deterministic
regeneration. The migration run passes 64 GraphQL tests and 12 TLS tests;
four virtual-clock deletion tests prove that exhausted polling fails explicitly
and preserves typed query errors. The full workspace type-check and JSDoc
check pass.

These results were recorded on Effect rc.113 before rebasing onto the rc.115
upgrade in main. The rebase preserves upstream removal of the SNI shim and
adapts the no-verify normalization tests. The rc.115 results below supersede
that earlier validation record.

## Single-invocation verification on Effect rc.115

Both Foldkit tests are explicitly skipped for the fixture's incompatible Effect
API. The complete Railway directory was then selected in one invocation:

```sh
timeout -k 5 240 doppler run --project alchemy-v2 --config dev -- \
  env ALCHEMY_TEST_STAGE=test_graphql_whole \
  RAILWAY_TEST_PROJECT_NAME=alchsuite-graphqlwhole \
  pnpm test test/Railway --profile testing --retry 0 --concurrency 8 --sequential
```

The runner collected 55 files / 85 tests. At the 240-second deadline it had
recorded **64 passed, 5 failed, 9 skipped, and 7 unfinished**; the command
exited 124. This was not a complete run or a passing suite.

- Group creation and the canvas Function lifecycle failed on
  `GraphQLTransportError` with HTTP 503 and a non-GraphQL response.
- The bindings fixture's `beforeAll` failed on the same HTTP 503, preventing
  its three tests from running; the runner counted them as failures.
- Template deployment/list/delete passed in the shared single-process run.
- SolidStart, StaticSite, SvelteKit, TanStackStart, Vite, Vocs, and Waku cloud
  tests were still running at the deadline; they have no final outcome.
- Nine skips comprise both Foldkit tests and the seven pre-existing gates
  described below. No additional tests were disabled.

The preceding complete rc.115 run in separate batches recorded 74 passed,
4 failed, and 7 skipped. Those failures were both Foldkit tests, template
service discovery, and StaticSite domain creation. Its separate SDK and TLS
checks passed 64 and 9 tests respectively. The workspace type-check reported
three AWS SigningError contract mismatches in DbAuthToken and S3 presigning.

## Explicit coverage limits

- Three existing Effect-native Function/RPC cases exceed the canvas command's
  96 KiB limit and remain skipped. The smaller Function and runtime binding
  cases above are exercised.
- Backup entitlement, connected GitHub repositories, and external ACME DNS
  require their documented test environment variables.
- Foldkit's local and cloud tests explicitly use `test.provider.skip`:
  installed `foldkit@0.148.2` requires `SchemaTransformation.transformOrFail`,
  which is unavailable in the workspace's Effect rc.115. Re-enable both
  when the fixture is compatible with the workspace Effect version.
- The existing Vocs local test remains skipped for its fixture cwd issue.

These limits must not be reported as passing live coverage.
