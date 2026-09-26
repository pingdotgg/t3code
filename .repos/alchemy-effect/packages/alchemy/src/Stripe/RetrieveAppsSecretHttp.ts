import { GetAppsSecretsFind } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import type { AppsSecret, AppsSecretScopeType } from "./AppsSecret.ts";
import { RetrieveAppsSecret } from "./RetrieveAppsSecret.ts";
import {
  asOptionalStringEffect,
  asStringEffect,
  attachStripeToken,
  authorizeWith,
  resolveStripeAuth,
} from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveAppsSecret}. Find is keyed by
 * `name` and `scope`.
 *
 * @layer
 * @provides Stripe.RetrieveAppsSecret
 */
export const RetrieveAppsSecretHttp = Layer.effect(
  RetrieveAppsSecret,
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (secret: AppsSecret) {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        secret as unknown as ResourceLike,
        ["apps_secrets_read"],
        "Stripe.RetrieveAppsSecret",
      );
      const name = yield* asStringEffect(secret.name);
      const scopeType = yield* asStringEffect(secret.scope.type);
      const scopeUser = yield* asOptionalStringEffect(secret.scope.user);
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;

      return Effect.fn(`Stripe.RetrieveAppsSecret(${secret.LogicalId})`)(
        function* (request?: { expand?: string[] }) {
          const user = yield* scopeUser;
          return yield* auth(
            GetAppsSecretsFind({
              ...(request ?? {}),
              name: yield* name,
              scope: {
                type: (yield* scopeType) as AppsSecretScopeType,
                ...(user !== undefined && user.length > 0 ? { user } : {}),
              },
            }),
          );
        },
      );
    });
  }),
);
