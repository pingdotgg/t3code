import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared HTTP-binding scaffolding for the ApiGateway capabilities
 * (`CreateApiKeyHttp`, `GetUsageHttp`, `FlushStageCacheHttp`, …).
 *
 * NOT exported from `index.ts` — this is internal plumbing, like
 * Cloudflare's `BucketHttp.ts`.
 *
 * API Gateway's control plane authorizes by HTTP verb (`apigateway:GET`,
 * `apigateway:POST`, …) against path-shaped ARNs
 * (`arn:aws:apigateway:{region}::/usageplans/{id}/keys`), so every
 * capability reduces to { verb, ARN paths, operation }. Everything else —
 * the runtime guard, host resolution, region lookup, and the
 * `host.bind` policy registration — is identical and lives here.
 */

/** API Gateway authorizes control-plane calls by HTTP verb. */
export type ApiGatewayIamVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Deploy-time half of an ApiGateway HTTP binding: resolves the host
 * Function, and registers an IAM policy statement for
 * `apigateway:{verb}` over the given API Gateway ARN paths. A no-op at
 * runtime (`__ALCHEMY_RUNTIME__`) and for non-Lambda hosts.
 *
 * @param cap fully-qualified capability name, e.g. `AWS.ApiGateway.GetUsage`
 * @param target the bound resource (or a string literal for account-scoped
 *        capabilities) — used for the binding's identity label
 * @param verb the API Gateway IAM verb the capability requires
 * @param paths builds the ARN path list once the deploy region is known;
 *        entries may be `Output`-derived (e.g. `Output.interpolate`)
 */
export const registerApiGatewayBinding = Effect.fn(function* (opts: {
  cap: string;
  target: unknown;
  verb: ApiGatewayIamVerb;
  paths: (region: string) => ReadonlyArray<Input<string>>;
}) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const host = yield* Binding.Host;
  if (!isBindingHost(host)) return;
  const { region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
    region: string;
  }>;
  yield* host.bind`Allow(${host}, ${opts.cap}(${opts.target}))`({
    policyStatements: [
      {
        Effect: "Allow",
        Action: [`apigateway:${opts.verb}`],
        Resource: [...opts.paths(region)],
      },
    ],
  });
});
