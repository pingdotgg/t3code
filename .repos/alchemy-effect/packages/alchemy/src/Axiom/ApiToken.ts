import * as Axiom from "@distilled.cloud/axiom";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type ApiTokenProps = Omit<Axiom.CreateAPITokenInput, never>;

export type ApiToken = Resource<
  "Axiom.ApiToken",
  ApiTokenProps,
  Omit<Axiom.CreateAPITokenOutput, "token"> & {
    /**
     * The bearer token. Returned only by `create` (and `regenerate`); Axiom
     * does not return it on subsequent reads. Persisted in resource state via
     * `Redacted` — handle with care.
     */
    token: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * An Axiom API token — a scoped bearer token used to authenticate API
 * requests (ingest, query, admin). Capabilities are pinned at creation time;
 * changing any field triggers a **replacement** because Axiom does not
 * expose an update endpoint.
 *
 * The raw token value is returned only by `create`. After that, Axiom
 * never echoes it back, so it is captured into `output.token` (as a
 * {@link Redacted}) on initial create and persisted in resource state.
 * Treat resource state as sensitive — anyone with read access can recover
 * the token. Pair with a secret store for downstream consumption.
 *
 * @see https://axiom.co/docs/reference/tokens
 *
 * @section Creating an API Token
 * @example Ingest-only token scoped to one dataset
 * ```typescript
 * const ingest = yield* Axiom.ApiToken("ingest", {
 *   name: "prod-ingest",
 *   description: "OTEL collector ingest",
 *   datasetCapabilities: {
 *     "my-app-traces": { ingest: ["create"] },
 *   },
 * });
 * ```
 *
 * @example Read-only query token
 * ```typescript
 * yield* Axiom.ApiToken("query", {
 *   name: "grafana-reader",
 *   datasetCapabilities: {
 *     "my-app-traces": { query: ["read"] },
 *     "my-app-logs":   { query: ["read"] },
 *   },
 * });
 * ```
 *
 * @section Consuming the Token
 * @example Forward the token via Cloudflare Secrets
 * ```typescript
 * const secret = yield* Cloudflare.Secret("axiom-token", {
 *   value: ingest.token,
 * });
 * ```
 */
export const ApiToken = Resource<ApiToken>("Axiom.ApiToken");

export const ApiTokenProvider = () =>
  Provider.effect(
    ApiToken,
    Effect.gen(function* () {
      const create = yield* Axiom.createAPIToken;
      const get = yield* Axiom.getAPIToken;
      const del = yield* Axiom.deleteAPIToken;

      return {
        stables: ["id", "token"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          // First create — let the engine create normally.
          if (output == null) return undefined;
          // Axiom has no update endpoint for tokens, so any actual change
          // to the inputs forces a replacement (which mints a new bearer
          // value). If nothing changed, fall through to `noop` so we don't
          // needlessly rotate the token on every deploy.
          if (deepEqual(olds, news)) return undefined;
          return { action: "replace" } as const;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — Axiom does not expose an update endpoint for tokens,
          // so any actual change to the inputs is forced to a replacement
          // by `diff` above. That means by the time `reconcile` runs we
          // are either (a) creating fresh, or (b) re-reconciling identical
          // inputs against an existing token.
          if (output !== undefined) {
            // Identical inputs — Axiom does not echo the bearer back, so
            // the cached `output` (with the persisted Redacted token) is
            // the authoritative current state.
            return output;
          }

          // Ensure — mint a new token. Axiom returns the bearer exactly
          // once; capture it into Redacted state for downstream consumers.
          const result = yield* create(news);
          if (!result.token) {
            return yield* Effect.die(
              new Error("Axiom did not return a token on create"),
            );
          }
          return {
            ...result,
            token: Redacted.make(result.token),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get({ id: output.id }).pipe(
            Effect.map((current) => ({ ...current, token: output.token })),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
