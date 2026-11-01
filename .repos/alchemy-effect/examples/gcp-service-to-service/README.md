# gcp-service-to-service

One Cloud Run service calling another, private one with Google-signed
identity. This is the GCP counterpart of `AWS.Lambda.InvokeFunction`.

| Service   | Access  | Routes                                    |
| --------- | ------- | ----------------------------------------- |
| `Gateway` | public  | `GET /` (health), `GET /quote?n=` (proxy) |
| `Quotes`  | private | `GET /quote?n=`                           |

- `Quotes` ([src/Quotes.ts](./src/Quotes.ts)) keeps Cloud Run's invoker
  IAM check on (the default). Requests without a valid ID token get `403`
  from Cloud Run's front end and never reach the container.
- `Gateway` ([src/Gateway.ts](./src/Gateway.ts)) sets
  `invokerIamDisabled: true` so anyone can call it. It forwards
  `GET /quote` to `Quotes` and relays the response.

## The binding

```ts
const quotes = yield* GCP.Run.InvokeService(Quotes);
const response = yield* quotes.fetch("/quote");
```

Provide `GCP.Run.InvokeServiceHttp` on the caller.

| When    | What `InvokeService` does |
| ------- | ------------------------- |
| Deploy  | Grants `roles/run.invoker` on the `Quotes` service's own IAM policy to the `Gateway`'s runtime service account (no project-level role). Binds the `Quotes` URL into the `Gateway`. |
| Runtime | Mints an ID token from the metadata server (`.../service-accounts/default/identity?audience=<Quotes URL>`), caches it until 5 minutes before it expires, and sends it as `Authorization: Bearer`. |

Alchemy mints each host's runtime service account, so the grant applies
to the `Gateway` only. Other services in the project still get `403`.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

```sh
pnpm deploy --profile <name>
```

This needs Docker (Alchemy builds both images locally). The stack outputs `url` (the gateway) and
`quotesUrl`:

```sh
curl "$url/quote?n=1"       # 200 — served by Quotes via the gateway
curl "$quotesUrl/quote"     # 403 — no Google identity
```

To call `Quotes` as yourself, send your own identity token. This works
only if your account holds `run.invoker` on it (project owners do):

```sh
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$quotesUrl/quote"
```

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

The test deploys the stack and checks three things: the gateway returns
`200` with a body from `Quotes`, a direct unauthenticated call to
`Quotes` returns `403`, and `run.invoker` on `Quotes` is held by the
gateway's service account only. It then destroys the stack and confirms
both services are gone. The test is skipped when
Docker is not running.

## Destroy

```sh
pnpm destroy --profile <name>
```
