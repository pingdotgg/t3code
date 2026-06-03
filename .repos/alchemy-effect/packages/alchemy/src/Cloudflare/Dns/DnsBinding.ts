import {
  Credentials,
  fromApiToken,
} from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { type HttpClient } from "effect/unstable/http/HttpClient";
import type * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { ApiTokenPermissionGroupRef } from "../ApiToken/Common.ts";
import type { Zone } from "../Zone/Zone.ts";

/**
 * Runtime accessor for a DNS binding's token, obtained by binding the
 * {@link AccountApiToken}'s `value` output in the Worker's Init phase. Reads the
 * value back from the Worker's environment at runtime. DNS record operations
 * are zone-scoped (the `zoneId` is passed per call), so the account id is not
 * needed at runtime.
 */
export interface DnsToken {
  /** The token's plaintext value (injected as a `secret_text` binding). */
  value: Effect.Effect<Redacted.Redacted<string>>;
}

/**
 * Bind an {@link AccountApiToken}'s `value` output into the Worker (as a
 * `secret_text` binding) and return the {@link DnsToken} accessor.
 */
export const bindDnsToken = (token: AccountApiToken) =>
  Effect.gen(function* () {
    const value = yield* token.value;
    return { value } satisfies DnsToken;
  });

/**
 * Resolve credentials from a bound token and provide them (plus the
 * fetch-based HTTP client) to a raw SDK operation.
 */
export const authorizeDns =
  (token: DnsToken) =>
  <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> =>
    token.value.pipe(
      Effect.flatMap((value) =>
        eff.pipe(
          Effect.provide(
            fromApiToken({ apiToken: Redacted.value(value) }).pipe(
              Layer.provideMerge(FetchHttpClient.layer),
            ),
          ),
        ),
      ),
    );

/**
 * Shared runtime body for a DNS binding: create a token scoped to the requested
 * zone, attach the (narrow) policy, bind the token's value and the zone's id
 * into the Worker, then build the client. Pass the result to
 * `Layer.effect(<Binding>, ...)`.
 *
 * The zone's `zoneId` is bound into the Worker at init time, so the resulting
 * client closes over it and callers never pass it per request — the
 * provisioned token only grants access to that one zone anyway.
 */
export const makeDnsClient = <C>(
  Policy: Binding.Policy<
    any,
    any,
    (token: AccountApiToken, zone: Zone) => Effect.Effect<void>
  >,
  tokenId: string,
  makeClient: (token: DnsToken, zoneId: Effect.Effect<string>) => C,
) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const attach = yield* Policy;

    return Effect.fn(function* (zone: Zone) {
      const token = yield* Token(tokenId);
      yield* attach(token, zone);
      const zoneId = yield* zone.zoneId;
      return makeClient(yield* bindDnsToken(token), zoneId);
    });
  });

/**
 * Build the deploy-time policy layer for a DNS binding: attach an allow policy
 * with the given permission groups, scoped to the requested zone
 * (`com.cloudflare.api.account.zone.<zoneId>`).
 */
export const makeDnsPolicyLive = <Self, Id extends string>(
  Policy: Binding.Policy<
    Self,
    Id,
    (token: AccountApiToken, zone: Zone) => Effect.Effect<void>
  >,
  sid: string,
  permissionGroups: ApiTokenPermissionGroupRef[],
) =>
  Policy.layer.succeed((_host, token, zone) =>
    token.bind`${sid}(${zone})`({
      policies: [
        {
          effect: "allow",
          permissionGroups,
          resources: zone.zoneId.pipe(
            Output.flatMap(
              (zoneId) =>
                Output.interpolate`com.cloudflare.api.account.zone.${zoneId}`,
            ),
            Output.map((zoneId) => ({
              [zoneId]: "*",
            })),
          ),
        },
      ],
    }),
  );
