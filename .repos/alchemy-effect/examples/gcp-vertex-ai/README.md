# gcp-vertex-ai

A public chat endpoint on Cloud Run that answers with Gemini on Vertex AI —
the GCP counterpart of [`aws-bedrock-ai`](../aws-bedrock-ai).

| Route        | Does                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `GET /`      | health check                                                         |
| `POST /chat` | `{ prompt, system?, temperature?, maxOutputTokens? }` → `{ text, finishReason, modelVersion, usage }` |

## Architecture

- `src/Chat.ts` — an Effect-native `GCP.Function` (a Cloud Run service) with
  `main: import.meta.url` and `invokerIamDisabled: true`. Its init phase binds
  `gemini-2.5-flash` with `GCP.AIPlatform.GenerateContent`; `fetch` calls it.
- `alchemy.run.ts` — the stack; outputs the service URL, name, and runtime
  service account.

No API key exists anywhere. The container calls Vertex AI as its own runtime
service account, using tokens from the Cloud Run metadata server.

## Bindings and IAM

| Binding                                                          | Grants                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GCP.AIPlatform.GenerateContent("gemini-2.5-flash")` (`GenerateContentHttp`) | `roles/aiplatform.user` to the service's runtime service account, on the project |
| `invokerIamDisabled: true` on the service                        | no IAM check on invoke — the URL is public                       |

Alchemy mints a dedicated runtime service account for the service; the grant
goes to that account only and is revoked on destroy. Vertex AI publisher
models have no resource-level IAM policy, so the role sits on the project.

The model id is a plain string because publisher models are not resources
you create. Pass `{ model, location }` to pin a region; the default location
is `global`:

```ts
const gemini = yield* GCP.AIPlatform.GenerateContent({
  model: "gemini-2.5-flash",
  location: "us-central1",
});
const answer = yield* gemini.text("Write a haiku about rain.");
```

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

The Vertex AI API (`aiplatform.googleapis.com`) must be enabled on the
project, and Docker must be running for the local image build.

```sh
pnpm deploy --profile <name>
```

```sh
curl -X POST "$url/chat" -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about Cloud Run"}'
```

A fresh `roles/aiplatform.user` grant can take a minute or two to reach
Vertex AI, during which `/chat` answers `500`.

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

Deploys the stack, checks the project IAM policy for the grant, sends
`Reply with exactly: pong` to `/chat` and expects `pong` back, then destroys
the stack and verifies the service is gone and the grant revoked. Skipped
when Docker is not running.

## Destroy

```sh
pnpm destroy --profile <name>
```
