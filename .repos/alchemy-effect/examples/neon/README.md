# Neon

One shared backend for an upload journal: a Vite browser UI, managed Better Auth, private object uploads, Postgres metadata, and idempotent storage-event processing. The default stack uses Effect; `alchemy.native.ts` exposes the same browser API through native Fetch. Focused modules add typed settings, public assets, a cron journal, optional AI streaming, and alternative Function forms. All modules use the same `Project` and `Backend` resources, not independent nested projects.

The 13 `examples/neon-website-*` packages remain separate, one per Website framework.

## Structure

| Module | Capability |
| --- | --- |
| `src/resources.ts` | Shared Project, migrated Branch, Auth, private Uploads, public PublicAssets, typed Settings object and public welcome object |
| `src/Api.ts` | Effect Function, `Connect`, `ConnectAuth`, `ReadWriteBucket`, `ReadObject`, JWT-protected `/api/me`, `/api/settings`, and upload routes |
| `src/native.ts` | Native Fetch version of those browser routes, presigning and storage-event processing |
| `src/Events.ts` | `CronEventSource` at 02:00 UTC; records invocation IDs idempotently in `scheduled_runs` |
| `src/ai/` | Native streaming UI and tested Effect `QueryAIGateway` / `LanguageModel` SSE client |
| `src/forms/` | Native Fetch with attached Postgres pool, bare function, Hono, and Effect Layer Function forms |
| `src/features.ts` | Shared cron and explicit opt-ins for AI and additional Function forms |
| `web/` | Sign-in, private upload, event-backed status and signed download UI |
| `alchemy.preview.ts` | Child branch, explicit child storage trigger, Auth adoption and isolated Website |

The native alternative reuses the Effect cron module and optional AI/forms modules. The preview is intentionally the upload journal only: it does not enable inherited cron triggers or create new AI/forms deployments. The settings object is outside `incoming/`, so deploying it does not invoke upload processing. Public assets are separate from private uploads; `welcome.txt` is intentionally anonymously readable. Permissions management and a new Data API example are out of scope.

Read the [step-by-step tutorial](https://alchemy.run/neon/tutorial) for the resource and binding definitions.

## Run

Install this repository's workspace dependencies and use Node 24. Configure the Neon `testing` profile or provide `NEON_API_KEY` to the deployment process only. The example uses `aws-us-east-2` and creates billable cloud resources.

If you already deployed the old tutorial, follow [local-state migration](#existing-deployments-and-local-state-migration) before running these commands. From this directory, choose one backend:

```sh
pnpm run deploy --profile testing --stage upload-journal
# Or, for the separate native stack:
pnpm deploy:native --profile testing --stage upload-journal
```

Open the returned website URL. Create an account, select a small file, and submit it. A storage event validates the uploaded metadata and updates the journal; the browser does not mark the upload ready itself.

To run only the frontend against that deployed backend:

```sh
VITE_API_URL='<apiUrl>' VITE_NEON_AUTH_URL='<authUrl>' pnpm dev:web
```

The frontend listens at `http://127.0.0.1:43187`. The example deliberately allows localhost and disables email verification. Every data request still requires a verified JWT. Set `UPLOAD_APP_ORIGIN` before deployment to restrict API origins. No deployment API key belongs in a `VITE_*` variable.

## Optional AI streaming

Set `NEON_EXAMPLE_AI=true` to include both AI Functions in this backend. This does **not** enable inference. Keep secrets in a private, ignored `.env` in this directory:

```dotenv
NEON_EXAMPLE_AI=true
NEON_EXAMPLE_API_KEY=<a long random application secret>
NEON_AI_MODEL=gpt-5-mini
NEON_AI_ALLOW_PAID=false
```

Use a model ID actually supported by your branch. The outputs `ai.nativeUrl`, `ai.effectUrl`, and `ai.gatewayUrl` identify the two Functions and shared gateway. Open `ai.nativeUrl` for the streaming browser UI; `ai.effectUrl` is an API, not a second page. Both accept `POST /chat` with `{ "prompt": "Hello" }` and `Authorization: Bearer <example key>`. That secret is an application key, never a Neon account key or gateway token. The upload journal continues to use managed Auth JWTs instead.

Missing/wrong authorization returns 401; malformed, blank, non-string, or over-4000-character prompts return 400; valid authenticated requests return 503 while inference is disabled. Neither disabled handler constructs a model. Gateway tokens remain server-side, and the UI does not persist the entered key. The APIs stream text-delta/error SSE events with a normal `[DONE]` terminator; the Effect implementation preserves request context for deferred body consumption, sanitizes errors, and interrupts consumption on cancellation.

Inference additionally requires the exact explicit `NEON_AI_ALLOW_PAID=true` setting, an entitled account, existing prepaid credits, and an available model. Do not enable it just to test the example. No code purchases credits or upgrades an account. Responses are limited to 128 output tokens. The native SDK disables automatic retries; the Effect handler adds no retries. The Effect adapter uses OpenAI-compatible `/v1/chat/completions`; Responses-only models and native Anthropic thinking/cache controls require their own SDK routes. This example streams text, not tool calls or structured objects.

## Optional Function forms

Set `NEON_EXAMPLE_FORMS=true` and a private `APP_TOKEN` to deploy the four handlers in `src/forms/`. The `forms` output contains `nativeUrl`, `bareUrl`, `honoUrl`, and `layerUrl`. Native SQL queries require `Authorization: Bearer <APP_TOKEN>`; its `/health`, the bare path echo, Hono `/health`, and Layer greeting intentionally return only public demonstration data. These functions share the upload journal branch. They are not separate stacks or authentication substitutes.

## Tests

From `examples/neon`, run the offline suite only:

```sh
timeout 240 bun test test/policy.test.ts test/EffectApi.test.ts test/composition.test.ts
```

`pnpm test` selects the same offline files. The 17 preserved Effect AI tests use a mock model, including for paid-gate, SSE/context, error, and cancellation coverage; no inference is performed. Composition and native negative-path checks are offline too.

`test/integ.test.ts` and `test/preview.test.ts` are preserved **live** suites. `pnpm test:integ` deploys real resources; `pnpm test:preview` uses configured parent/preview IDs and writes data. Run either only with explicit cloud-test authorization. Preview fixtures must be disposable, test-owned stacks: process a parent upload before forking, set `PARENT_PROJECT_ID`, `PARENT_BRANCH_ID`, `PARENT_BUCKET_NAME`, and `PREVIEW_BRANCH_ID` from those stacks, and stop parent browser writes before asserting isolation. Never point this test at an existing user's backend. Do not run bare `bun test` when intending offline verification.

## Verification limits

The 46 offline tests and consolidated Effect backend's live lifecycle passed: private/public buckets, typed objects, Auth, upload and cron trigger configuration, unauthenticated-request rejection, real upload-event processing, persisted SQL status, byte-for-byte download, and normal cleanup. The lifecycle signs its upload from the test process; the separate browser checks below exercise the Function's authenticated upload route.

The actual native Website passed desktop (1440×1000) and mobile (390×844) browser flows with disposable managed-Auth accounts: signup, private listing, typed settings, direct browser upload, event-backed ready status, exact signed-download contents, reload persistence, signout, wrong-password rejection, and sign-in. Unauthorized/invalid-JWT requests, unattested events, malformed/empty/oversized uploads, missing downloads, and anonymous storage reads were rejected. Neither viewport overflowed or reported a page error. One earlier native upload remained pending through the bounded event wait; that failed observation is retained, not treated as success.

The Effect Website now passes the same complete desktop/mobile browser flows. The earlier HTTP 500 was a populated `GET /api/uploads`, not the upload POST: the native Effect Postgres driver returns `bigint` sizes, which cannot be JSON-encoded directly. The API now serializes sizes without precision loss and converts epoch-millisecond timestamps to ISO strings; regression tests cover pending, zero, ordinary and large byte counts.

The preview also passed first-deployment scoped Auth adoption, desktop/mobile upload and download flows, and both live isolation tests. Those tests verify inherited file/SQL data, disabled inherited triggers, the new enabled `PreviewUploads` trigger, no inherited custom domains, child-only writes, unchanged parent data/configuration and temporary credential cleanup. The engine now defers its ownership probe until the new child branch identity resolves; the example retains resource-scoped adoption rather than a stack-wide override. After destroying the preview, independent reads confirmed parent Auth and processed uploads survived, and the parent's full desktop/mobile browser flows passed again.

Verification evidence is retained locally under ignored `.alchemy/acceptance/`. The acceptance and diagnostic stacks were destroyed through their normal stack lifecycles; independent SDK reads confirmed the owned projects and preview branch absent. No scheduled cron firing, optional consolidated AI/Function-form deployment, or paid inference was tested in this pass. Earlier independent Neon Function update probes served old code/environment after the requested active deployment ID advanced. Keep unresolved failures visible; do not substitute deployment credentials, use stack-wide adoption, or erase state to proceed.

The 10 MiB upload limit is an application check, not an S3-enforced quota. Processing validates size/content type, not malware. Signed URLs are temporary bearer capabilities. Add production rate limits, budgets, email verification, and content validation before exposing this application.

## Existing deployments and local-state migration

Only tracked source files moved. Ignored `.alchemy` state, credentials, build output, and local evidence were deliberately left in the original directories. **Do not deploy from this new directory against an existing stage until you have backed up and copied the original tutorial's `.alchemy` state and required private configuration here.** Do not overwrite existing destination state, commit secrets, or delete the original backup. The stack names `NeonUploadTutorial`, `NeonUploadNativeTutorial`, and `NeonUploadPreview`, plus the original logical resource IDs, are unchanged. Keep the same profile and stage. Review the plan: a path move must not silently create a second upload backend. The new `0002_scheduled_runs.sql` migration leaves the original upload migration unchanged.

The other six old examples had independently owned projects; consolidation cannot transfer their resources or data automatically:

| Former directory | Existing stack identity |
| --- | --- |
| `examples/neon-ai-gateway` | `NeonAIGatewayExample` |
| `examples/neon-auth` | `NeonManagedAuthExample` |
| `examples/neon-function` | `neon-function` |
| `examples/neon-function-effect` | `neon-function-effect` |
| `examples/neon-storage` | `NeonStorage` |
| `examples/neon-triggers` | `neon-triggers` |

Before retiring any of those deployments, export any data you need and restore its pre-consolidation source revision in its original directory alongside its retained private state/configuration. Use that revision's ordinary destroy command with the original profile and stage, only when you explicitly intend to delete that stack. Do not run the consolidated destroy expecting it to clean up these independent stacks. Never copy their state over the upload journal's state, use adoption to take over their resources, or erase state as cleanup. Verification deployed and destroyed its own test stack; it did not migrate or destroy any of these existing deployments.

## Cleanup

Keep `.alchemy` and use the same stage as deployment. Destroy preview stacks before their parents, with the parent identity environment variables still set:

```sh
pnpm preview:destroy --profile testing --stage upload-preview
pnpm destroy --profile testing --stage upload-journal
# If you deployed the native alternative:
pnpm destroy:native --profile testing --stage upload-journal
```

The native and Effect variants are independent stacks. Destroy both if you deployed both. Bucket destruction intentionally deletes its files. Never delete local state as a substitute for cloud cleanup.
