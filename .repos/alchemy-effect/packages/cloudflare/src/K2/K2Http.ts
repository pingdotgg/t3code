import type { ProviderMode } from "alchemy/ProviderMode";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { requireLiveResource } from "../HttpBindingDev.ts";
import { authorizeWith } from "../HttpClientUtils.ts";

/**
 * Shared scaffolding for the HTTP-backed K2 services. Internal — not
 * exported from the K2 barrel.
 */

/**
 * Injectable auth for the K2 HTTP clients. The scoped-token variant
 * (`*Http`) and the current-credentials variant (`*Local`) share the same
 * request path and differ only in how credentials reach the SDK operation.
 * K2 data-plane operations are addressed by stream id, so no account id is
 * needed.
 */
export interface K2Auth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

type K2PermissionGroup = "K2 Produce" | "K2 Consume";

/**
 * Mint (or extend) the host's scoped {@link AccountApiToken} with the given
 * K2 permission group, bind it into the host at deploy time, and return
 * the {@link K2Auth} that authorizes requests with it.
 */
export const makeK2HttpAuth = Effect.gen(function* () {
  const Token = yield* AccountApiToken;
  const self = yield* Self;

  return Effect.fn(function* (
    resource: { readonly Type: string; readonly LogicalId: string; readonly Mode?: ProviderMode },
    permissionGroup: K2PermissionGroup,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__) yield* requireLiveResource(resource);
    const token = yield* Token(`${self.LogicalId}Token`);
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const { accountId } = yield* CloudflareEnvironment.current;
      yield* token.bind`${resource.LogicalId}`({
        policies: [
          {
            effect: "allow",
            permissionGroups: [permissionGroup],
            resources: {
              [`com.cloudflare.api.account.${accountId}`]: "*",
            },
          },
        ],
      });
    }
    const value = yield* token.value;
    return { authorize: authorizeWith({ value }) } satisfies K2Auth;
  });
});

/**
 * Capture the ambient credentials (the stack's providers layer during
 * stack-eval) so a client can run with the current credentials instead of a
 * scoped token — for Actions and other deploy-time Effects.
 */
export const makeK2LocalAuth = Effect.gen(function* () {
  const context = yield* Effect.context<Credentials | HttpClient.HttpClient>();
  return {
    authorize: (eff) => eff.pipe(Effect.provideContext(context)),
  } satisfies K2Auth;
});
