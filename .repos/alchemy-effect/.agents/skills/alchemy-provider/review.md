# Provider review gate

Each row turns a rule from `AGENTS.md` or the skill into a check with a
command and an expected result. The rows come from the first review of the
GCP provider and the corrections made during it; on the pre-fix GCP code
these greps returned hundreds of hits each.

Run it at every wave boundary and before calling a provider done. Use a
fresh reviewer (a subagent with no stake in the code) and have it report,
for every item, the command it ran, the count, and the file:line of each
hit it did not accept. "Looks fine" is not an answer. Every accepted hit
needs a one-line reason.

`<P>` is the provider name. Paths are relative to the repo root:
`src/<P>` means `packages/<p>/src` (the provider package) and `test/<P>`
means `packages/integration-tests/test/<P>`. The greps find candidates;
read each hit.

## 0. Coverage

Run this first; the other sections only judge the code that exists.

| Check | Command | Expect |
| --- | --- | --- |
| Every service cataloged | compare `ls submodules/distilled/packages/<pkg>/src/services` with `ls processes/<P>/catalog` | one catalog file per service |
| Nothing left unbuilt | count statuses in `processes/<P>/catalog/INDEX.md` | no `missing` or `implemented` rows; every `out-of-scope` and `blocked` row has a reason or exact error |
| Index matches the code | every `tested` row has a `Resource<...>("<P>.<Service>.<Name>")` in `src/<P>` and a registered provider in `Providers.ts` | yes |
| One test file per resource | every `tested` row has `test/<P>/<Service>/<Name>.test.ts` | yes |
| Operations classified | every operation in each distilled service module appears in its catalog file as `resource-lifecycle`, `binding`, `event-source`, or `internal` with a reason | yes; the provider's port of `scripts/audit-service.ts` prints no unclassified operations |
| Binding coverage | the audit's `missingBindings` per service, and `rg -l 'Binding\.Service<' src/<P> \| xargs -n1 dirname \| sort -u \| wc -l` against the services with `binding` operations | no missing bindings; every service with data-plane operations has bindings (AWS: 205 of 212) |
| Bindings through distilled | read each `*Http.ts` | wraps a `@distilled.cloud/<pkg>` operation; no `HttpClientRequest` |
| Non-resource deliverables | index rows for runtime, event sources, websites, examples | none `missing` |
| Skill freshness | `git log -1 --format=%H -- .agents/skills/alchemy-provider` vs the `Skill: <sha>` line at the top of `INDEX.md` | equal; a newer skill commit means re-read it and add rows for its new deliverables |
| Framework examples | `ls examples \| grep '^<p>-website-'` vs `ls examples \| grep '^hetzner-website-'` | one per framework the provider hosts (skip when it can't host websites) |
| Workload examples | `ls examples \| grep '^<p>-'` against the workload table in Step 10 | one per workload the cloud supports; each registered in `tsconfig.json` and `scripts/test-examples.ts`, with a passing `test/integ.test.ts` |
| Docs generated for everything | `ls website/src/content/docs/providers/<P>` after `pnpm docs:gen` | one page per resource and binding page group, matching the index |
| Out-of-scope list published | the overview page's "Out of scope" section | matches the `out-of-scope` rows |

## How to compare against what good looks like

For each service, open the closest AWS or Cloudflare equivalent and compare
side by side: props naming, `diff`, `reconcile`, binding shape, test shape,
JSDoc examples. Where the new provider differs, the difference needs a
reason the platform forces. References:

| Concern | Reference |
| --- | --- |
| Small reconcile with labels, `list`, adoption | `packages/hetzner/src/SshKey.ts` |
| Multi-aspect reconcile | `packages/aws/src/DynamoDB/Table.ts`, `packages/aws/src/Kinesis/Stream.ts` |
| Read/Write/ReadWrite bindings, shared scaffolding unexported | `packages/cloudflare/src/R2/` |
| Bindings that reach any host | `packages/aws/src/AWSBindings.ts`, `packages/gcp/src/GCPBindings.ts`, `packages/aws/src/SQS/BindingHttp.ts` |
| Package shape | `packages/hetzner/` (`package.json`, `tsconfig.json`, `src/Contributions.ts`) |
| Bindings tested inside a deployed host | `packages/integration-tests/test/AWS/DynamoDB/Bindings.test.ts` + `handler.ts` |
| Framework websites on a CDN + functions | `packages/aws/src/Website/` (S3 + CloudFront + Lambda), `packages/cloudflare/src/Website/` |
| Framework websites on containers/VMs (only when the cloud has no CDN or functions) | `packages/fly/src/Website/`, `packages/hetzner/src/Website/` |

## 1. Package

| Check | Command | Expect |
| --- | --- | --- |
| Exports generated | `pnpm exports:check` | up to date; no hand-written entries |
| Provider layers | `pnpm lint:providers` | no `unknown`/`any` requirement on `providers()` |
| Core untouched | `git diff origin/main --stat -- packages/alchemy/src` | empty; anything core needs is a `Contributions` field |
| Package boundary | `rg -n "from \"(@alchemy\.run/[\w-]+\|alchemy)/.*internal" src/<P>` and `rg -n "\.\./\.\./[a-z-]+/src" src/<P>` | 0; other packages reached only through their public exports |
| Contributions | read `src/<P>/Contributions.ts` and `package.json` `alchemy.contributes` | lazy `import()` fields only; listed in `contributes` |
| Globals | `ls src/<P>/globals.d.ts` and `rg -n 'packages/<p>/src/globals' .gitignore` | both present |
| Registration | `git grep -il hetzner -- ':!packages/hetzner' ':!submodules' ':!examples'` vs the same for `<p>` | every file that lists Hetzner lists `<P>` where it applies |
| Version | `grep '"version"' packages/<p>/package.json packages/aws/package.json` | equal (packages release in lockstep) |

## 2. Effect code

| Check | Command | Expect |
| --- | --- | --- |
| Nested yields (`f(yield* x)`) | `rg -n 'yield\* [\w.]+\([^)]*yield\*' src/<P> test/<P> examples/<p>-*` | 0; bind to a named const first |
| `orDie` in lifecycle or binding init | `rg -n 'orDie' src/<P>` | only in credential and layer wiring (`Credentials.ts`, `Providers.ts`) |
| `Effect.promise` / swallowed causes | `rg -n 'Effect\.promise\|catchCause\|catchAllCause' src/<P>` | 0; use `Effect.tryPromise` with a typed error |
| Environment reads in resource code | `rg -n 'process\.env' src/<P>` | only `AuthProvider.ts` CI credentials |
| Widening casts | `rg -n 'as unknown as\|as any' src/<P>` | 0, or a comment naming the compiler limit |

## 3. Errors

| Check | Command | Expect |
| --- | --- | --- |
| Forbidden treated as missing | `rg -n '"Forbidden"' src/<P> test/<P>` | never in a not-found/gone path; a 403-for-missing API gets its own distilled tag |
| Message string matching | `rg -n 'message.*(includes\|match\|test)\(\|/[^/]*not found[^/]*/i' src/<P>` | 0; patch distilled with a matcher |
| Hand-written HTTP | `rg -n 'HttpClientRequest\.(get\|post\|put\|delete\|head\|patch)\(' src/<P>` | every hit is a presigned/SAS URL from the API or the user's own deployed endpoint, with a comment saying so; data-plane and credential calls go through distilled |
| Catch-all errors handled | `rg -n 'Unknown\w*Error\|HttpError' src/<P>` | 0 |
| Lists swallowing errors | `rg -n 'orElseSucceed\|catch\w*\(.*\[\]' src/<P>` | 0 on any list/read path |
| Single-page lists | read every `list` and `findBy*` helper | paginated (`.items(...)` or a page-token loop) |

## 4. Lifecycle

| Check | How | Expect |
| --- | --- | --- |
| One operation waiter | `rg -c 'waitFor\w*Operation\|pollOperation' src/<P>` | one definition in a shared module, many call sites |
| Realistic wait budgets | read each budget against the provider's documented create time | minutes for databases, clusters, environments; never a test-style 10 × 5s |
| Ready before return | read each `reconcile` | returns after the API reports ready, not after the create call |
| SQL migrations | for each resource hosting a SQL schema, `rg -n 'runMigrations' src/<P>` | a `migrations` prop driven by `@alchemy.run/sql/Migrations` (see **SQL database migrations** in `AGENTS.md`), with a live test that adds a file and redeploys |
| Identity change replaces | for each user-chosen name/id prop, read `diff` | `replace`; a rename test proves the old one is deleted |
| Ownership markers | `rg -n 'alchemy' src/<P> \| rg -v 'label\|tag\|import'` | markers only in labels/tags, never in user-visible fields |
| Copied helpers | `rg -c 'const (isNotFound\|isMissing\|ignoreMissing\|jsonEqual)' src/<P>` | one shared copy each |
| `output === undefined` branches | `rg -n 'output === undefined' src/<P>` | none inside `reconcile` |

## 5. Bindings and runtimes

| Check | How | Expect |
| --- | --- | --- |
| Bind, not host.bind | `rg -n 'host\.bind\(' src/<P>` and `rg -ln 'Bindings\.Bind' src/<P>` | bindings call `<P>Bindings.Bind`; no direct `host.bind` and no allowlist of host types |
| Foreign hosts | read `<P>Bindings.ts` | a non-native host gets a created identity + key bound into its env; `withCredentials` reads it at runtime |
| Other providers' types | `rg -n '"(AWS\|Cloudflare\|GCP\|Azure\|Fly\|Hetzner\|Railway)\.[A-Z]' src/<P>` minus `<P>`'s own prefix | 0; host access goes through `RuntimeContext` and core host services |
| Deploy-only reads | `rg -n 'Environment\.current' src/<P>` in binding files | every hit inside the `!globalThis.__ALCHEMY_RUNTIME__` block |
| Native bundles fold | `rg -ln 'HostBundle' src/<P>` | applied by every host bundler the provider owns |
| External-host suite | `ls test/<P>/ExternalHost` | a Cloudflare Worker (or other foreign host) calls the provider's bindings |
| Least privilege | list every role/permission each binding grants (`rg -n 'roles/\|permission' src/<P>`) | scoped to the bound resource; no `admin`/`editor`/`owner` unless the JSDoc says why |
| Revocation | read the host's grant sync | revokes only grants Alchemy added; pre-existing grants survive |
| Secrets | read each binding that hands out a credential | `Redacted`, never a plain env var or log line |
| Argument shapes | type test | callables accept the resource, the Effect producing it, and the resolved value (`WriteTable(table)` and `WriteTable(yield* table)`) |
| Runtimes identified | `rg -n 'runtime' processes/<P>/catalog/INDEX.md` vs every resource that runs user code | each one marked |
| Both forms | for each runtime: `Platform(` in its file, and an `### Async` JSDoc section | effectful class and async `main` form both ship and are documented |
| InferEnv | `rg -n 'export type InferEnv' src/<P>` | exported, and used in every async example |
| Both forms tested | `ls test/<P>/**/fixtures` | an effectful and an async fixture per runtime, each deployed and called |
| Workflow engine | the catalog's engine row, and `rg -ln 'WorkflowEngine' src/<P>` | the cloud's durable engine has an Effect engine Layer passing the eight conformance cases from `AGENTS.md`, or the row is `out-of-scope` with the reason |
| Runtime coloring | read each runtime callable | requires `RuntimeContext`; no `WorkerEnvironment`-style leaks |
| Event sources | compare with AWS `SQS.QueueEventSource` / Cloudflare cron | contract in the source service, per-host implementation layers |
| User-facing config | read setup docs and examples | region/account from profile or a `<P>.Region("...")` layer, matching `AWS.Region`; no new env vars |

## 6. Websites

Skip this section when the provider can't host websites; then `src/<P>/Website` doesn't exist.

| Check | Command | Expect |
| --- | --- | --- |
| Hosting choice | the catalog's website entry | names the cloud's static hosting, CDN, and function runtime, with a reason for each |
| No containers by default | `rg -n 'ContainerApp\|Run\.Service\|ECS\|Dockerfile\|image' src/<P>/Website` | 0, or the framework's JSDoc says why it needs a long-lived process and the cloud has no alternative |
| Static is compute-free | read `StaticSite.ts` and every assets-only path (Vite, SPA output) | uploads to object/asset storage; no server, function, or VM |
| CDN by default | read `FrameworkSite.ts` | the CDN is created without opting in; deploys purge or invalidate changed paths |
| Function target | `ls packages/frontend-frameworks/src/*/<p>.ts` | one per framework when SSR runs on functions; the Node target only on container/VM-only clouds |
| Live proof | each `Website/<Framework>.test.ts` | asserts the response came through the CDN and an SSR route ran on the function |

## 7. Tests

| Check | Command | Expect |
| --- | --- | --- |
| Gating flags | `rg -oh 'process\.env\.\w+' test/<P> \| sort \| uniq -c` | one provider-wide slow flag, entitlement flags, and ids of external systems a test needs; never sizes, regions, or other config as env vars |
| Lifecycle by default | `rg -c 'skipIf' test/<P>` against the file count | most lifecycles ungated |
| Accept-anything assertions | `rg -n 'expect\(\[' test/<P>` | each entitlement probe asserts one specific tag |
| Always-true assertions | `rg -n 'Array\.isArray\(.*\?\? \[\]\)\|toBeDefined\(\)' test/<P>` | each one asserts a real value |
| Early exits | `rg -n '^\s+return;$' test/<P>` | 0 |
| Bindings as the host | every `Bindings.test.ts` | deploys a fixture host and calls the binding over HTTP; at least one suite runs the binding on a foreign host (e.g. a Cloudflare Worker) |
| Redeploy coverage | tests for anything that syncs grants or bindings on the host | deploy twice and assert the grant survives |
| Leaks | after a full run, list owned resources in the test account | none |
| Slow test cases | the runner's `✓`/`✗` result lines, which end with each test's duration (`pnpm test:integration test/<P> ... \| rg '[✓✗]'`) | no failure-path case runs longer than a few minutes |
| Blocked rows | `rg -n 'blocked' processes/<P>/catalog/INDEX.md` | each needs payment, vendor approval, or hardware and names the exact request; quotas and preview features were requested through the API |
| Suite shape | how the suite was run | one process, whole provider directory; quotas shared with semaphores, never batched runs |

## 8. Docs, naming, and scope

| Check | Command | Expect |
| --- | --- | --- |
| Undeclared names in examples | `rg -n 'existing\.' src/<P>` and read every `**Example:**` | every identifier is declared in the example |
| Binding examples | count `@binding` blocks vs those showing the host and `Effect.provide(...)` | all of them |
| Resource examples | every `@resource` has at least one example | yes |
| Runtime JSDoc | `rg -c '\*\*Example:\*\*' <runtime file>` and its `###` headings next to `packages/aws/src/Lambda/Function.ts` | ten or more examples; intro, cautions, each form, configuration, packaging, a bindings section per service, event sources |
| Fat-head JSDoc | the same for each fat-head resource next to `packages/aws/src/S3/Bucket.ts` / `packages/cloudflare/src/R2/Bucket.ts` | five or more sections: creating, each configurable feature, binding to a runtime, runtime operations, event sources where they apply |
| Long-tail JSDoc | sample 20 long-tail files | intro with the cloud's type name, one complete creation example, a caution per replacing prop |
| Prop JSDoc | `rg -n '^  [a-zA-Z]+\??:' src/<P>/<Service>/<Resource>.ts` minus documented ones | every prop and attribute documented, with `@default` where there is one |
| Namespace casing | `ls src/<P>` | PascalCase |
| Singular names | read the list of exported resource names | correct English (`Index`, `Process`, `Batch`) |
| Scope | read the service list | no end-user data, OAuth-scoped, retired, or duplicate APIs; out-of-scope list on the overview page |
| PR description | read it | a `###` section with a snippet for every runtime, event source, websites, and each fat-head resource; long tail in one line; no snippet claims behavior no test proves |
| Docs build | `pnpm docs:check-jsdoc && pnpm docs:gen && pnpm docs:check` | clean |
| Hub structure | `ls website/src/content/docs/<p>/*/` next to `ls website/src/content/docs/aws/*/` | Overview, Setup, `tutorial/part-1..5`, `compute/choosing-a-runtime`, sections by concern; no `guides/`; every AWS section has a counterpart unless the provider has nothing for it |
| Hub snippets | read every fenced block with `import` lines | a complete file with a `// path` first line; no `...`, no module-scope `yield*`; code matches an `examples/<p>-*` project or a JSDoc example |
| Hub voice | `rg -n 'Alchemy (mints\|synthesizes\|reconciles)\|this page\|three ideas\|under the hood' website/src/content/docs/<p>` | 0; second person, one or two lines per snippet |
| Hub wiring | sidebar in `website/astro.config.ts`, `GROUP_ICONS`, `docs-tabs.ts`, `ProviderDirectory.astro`, `generate-llms-txt.ts` | every section listed in each; moved pages redirected in `website/src/worker.ts` |
