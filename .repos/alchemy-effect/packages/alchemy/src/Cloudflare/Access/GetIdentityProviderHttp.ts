import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { PermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { authorizeWith } from "../HttpClientUtils.ts";
import { isWorker } from "../Workers/Worker.ts";
import {
  type FindIdentityProviderOptions,
  GetIdentityProvider,
} from "./GetIdentityProvider.ts";
import { findFirst, toAttributes } from "./IdentityProviderLookup.ts";

const PERMISSION_GROUPS: PermissionGroupRef[] = [
  "Access: Organizations, Identity Providers, and Groups Read",
];

/**
 * Injectable auth for the lookup client: `authorize` provides
 * `Credentials` + `HttpClient` to the raw zero-trust list op, so the
 * client is agnostic to whether creds come from a bound scoped token
 * (Worker host) or the ambient plan-time credentials (data source).
 */
interface AccessIdpAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
  accountId: Effect.Effect<string>;
}

/**
 * HTTP implementation of the {@link GetIdentityProvider} binding.
 *
 * When bound inside a Worker, it mints a scoped {@link AccountApiToken}
 * with the `Access: Organizations, Identity Providers, and Groups Read`
 * permission and binds its outputs into the Worker so runtime code can
 * call the Access API. Hostless — the plan-time `execute` data source
 * ({@link getIdentityProvider}) or an Action — it runs with the ambient
 * current credentials instead; no token is minted.
 */
export const GetIdentityProviderHttp = Layer.effect(
  GetIdentityProvider,
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const env = yield* CloudflareEnvironment;
    const ambientCredentials = yield* Effect.serviceOption(Credentials).pipe(
      Effect.map(Option.getOrUndefined),
    );

    return Effect.fn(function* (options: FindIdentityProviderOptions) {
      // Resolved per call, NOT at layer build: the callable runs in the
      // caller's context, so a Worker host is visible here during the
      // Worker's init phase (plan and runtime) even though the layer
      // itself may have been built (and memoized) hostless by
      // `providers()`. Hostless callers — the plan-time `execute` data
      // source — resolve `undefined`.
      const host = yield* Binding.Host;
      if (isWorker(host)) {
        // Worker-hosted: mint the scoped token, attach the read policy
        // (a no-op once deployed), and bind the token's outputs into the
        // Worker so the client can authenticate at runtime.
        const token = yield* Token(`${host.LogicalId}Token`);
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          const { accountId } = yield* env;
          yield* token.bind("Cloudflare.Access.GetIdentityProvider", {
            policies: [
              {
                effect: "allow",
                permissionGroups: PERMISSION_GROUPS,
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }
        const bound = {
          value: yield* token.value,
          accountId: yield* token.accountId,
        };
        return makeGetIdentityProviderClient(
          { authorize: authorizeWith(bound), accountId: bound.accountId },
          options,
        );
      }

      // Hostless — plan-time data source: run with the ambient credentials
      // (refresh-aware, provided by the stack's providers layer).
      if (ambientCredentials === undefined) {
        return yield* Effect.die(
          new Error(
            "Cloudflare.Access.GetIdentityProvider requires either a Worker " +
              "host (runtime binding) or ambient Cloudflare credentials " +
              "(plan-time data source).",
          ),
        );
      }
      const { accountId } = yield* env;
      return makeGetIdentityProviderClient(
        {
          authorize: (eff) =>
            eff.pipe(
              Effect.provideService(Credentials, ambientCredentials),
              Effect.provide(FetchHttpClient.layer),
            ),
          accountId: Effect.succeed(accountId),
        },
        options,
      );
    });
  }),
);

const makeGetIdentityProviderClient = (
  auth: AccessIdpAuth,
  options: FindIdentityProviderOptions,
) =>
  Effect.fn("Cloudflare.Access.GetIdentityProvider")(function* () {
    const accountId = yield* auth.accountId;
    const match = yield* auth.authorize(
      findFirst(
        options.zoneId,
        accountId,
        (idp) =>
          (options.name === undefined || idp.name === options.name) &&
          (options.type === undefined || idp.type === options.type),
      ),
    );
    return match
      ? toAttributes(match, options.zoneId, accountId, undefined)
      : undefined;
  });
