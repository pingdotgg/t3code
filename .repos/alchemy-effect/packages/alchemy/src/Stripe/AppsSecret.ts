import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetAppsSecrets,
  GetAppsSecretsFind,
  CreateAppsSecret,
  CreateAppsSecretsDelete,
  type AppsSecret as StripeAppsSecret,
  type GetAppsSecretsFindRequestScope,
  type GetAppsSecretsRequestScope,
  type CreateAppsSecretsDeleteRequestScope,
  type CreateAppsSecretRequestScope,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const NAME_MAX_LENGTH = 250;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** The secret scope type. */
export type AppsSecretScopeType = "account" | "user";

/** Specifies the scoping of the secret. */
export interface AppsSecretScope {
  /**
   * The secret scope type. `account` secrets are shared by all Dashboard
   * users and the app backend. `user` secrets are visible to the app
   * backend and one Dashboard user.
   */
  type: AppsSecretScopeType;
  /**
   * The user ID. Required when `type` is `user`, and must not be set when
   * `type` is `account`.
   */
  user?: string;
}

export interface AppsSecretProps {
  /**
   * A name for the secret that's unique within the scope. If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Changing it replaces the secret.
   */
  name?: string;
  /**
   * The plaintext secret value to be stored.
   */
  payload: string;
  /**
   * Specifies the scoping of the secret. Changing type or user replaces
   * the secret.
   * @default { type: "account" }
   */
  scope?: AppsSecretScope;
  /**
   * Unix timestamp after which the secret deletes.
   */
  expiresAt?: number;
}

export type AppsSecret = Resource<
  "Stripe.AppsSecret",
  AppsSecretProps,
  {
    /** Stripe secret id (`appsecret_…` or `secret_…`). */
    id: string;
    /** Name unique within the scope. */
    name: string;
    /** Scoping of the secret. */
    scope: AppsSecretScope;
    /** Unix timestamp after which the secret deletes, if set. */
    expiresAt: number | undefined;
    /** Whether this secret has been deleted. */
    deleted: boolean | undefined;
    /** Unix timestamp when the secret was created. */
    created: number;
    /** Whether the secret exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Apps Secret — a named secret in the Stripe Apps Secret Store,
 * used by UI extensions and app backends. Secrets are unique per
 * `(name, scope)`. Create is upsert: posting the same name and scope
 * replaces payload and expiry. Name and scope are identity; changing
 * them replaces the secret. Destroy deletes it.
 *
 * Apps secrets have no metadata. Identity is name + scope. `list()`
 * enumerates account-scoped secrets (user-scoped secrets require a user
 * id and are not returned).
 *
 * @see https://docs.stripe.com/stripe-apps/store-secrets
 *
 * ### Creating a Secret
 * **Example:** Account-scoped secret
 * ```typescript
 * const apiKey = yield* Stripe.AppsSecret("third-party-api", {
 *   name: "third-party-api",
 *   payload: "sk_live_example",
 *   scope: { type: "account" },
 * });
 * ```
 *
 * **Example:** Generated name
 * ```typescript
 * const apiKey = yield* Stripe.AppsSecret("third-party-api", {
 *   payload: "sk_live_example",
 * });
 * ```
 *
 * ### Updating a Secret
 * **Example:** Rotate payload
 * ```typescript
 * const apiKey = yield* Stripe.AppsSecret("third-party-api", {
 *   name: "third-party-api",
 *   payload: "sk_live_rotated",
 *   scope: { type: "account" },
 * });
 * ```
 *
 * ### User-scoped secrets
 * **Example:** Per-user OAuth token
 * ```typescript
 * const oauth = yield* Stripe.AppsSecret("user-oauth", {
 *   name: "oauth-token",
 *   payload: "tok_example",
 *   scope: { type: "user", user: "usr_123" },
 * });
 * ```
 *
 * @resource
 */
export const AppsSecret = Resource<AppsSecret>("Stripe.AppsSecret");

export class AppsSecretNotResolved extends Data.TaggedError(
  "Stripe.AppsSecretNotResolved",
)<{
  name: string;
}> {}

type AppsSecretAttributes = AppsSecret["Attributes"];

const accountScope = (): AppsSecretScope => ({ type: "account" });

const toScope = (scope: AppsSecretScope | undefined): AppsSecretScope => {
  const type = scope?.type ?? "account";
  if (type === "user" && scope?.user !== undefined) {
    return { type, user: scope.user };
  }
  return { type };
};

const toWireScope = (
  scope: AppsSecretScope,
): CreateAppsSecretRequestScope &
  GetAppsSecretsFindRequestScope &
  GetAppsSecretsRequestScope &
  CreateAppsSecretsDeleteRequestScope =>
  scope.user !== undefined
    ? { type: scope.type, user: scope.user }
    : { type: scope.type };

const fromObservedScope = (
  scope: StripeAppsSecret["scope"],
): AppsSecretScope =>
  scope.user !== undefined
    ? { type: scope.type, user: scope.user }
    : { type: scope.type };

const scopesEqual = (left: AppsSecretScope, right: AppsSecretScope): boolean =>
  left.type === right.type &&
  (left.user ?? undefined) === (right.user ?? undefined);

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const toAttrs = (secret: StripeAppsSecret): AppsSecretAttributes => ({
  id: secret.id,
  name: secret.name,
  scope: fromObservedScope(secret.scope),
  expiresAt: secret.expires_at ?? undefined,
  deleted: secret.deleted,
  created: secret.created,
  livemode: secret.livemode,
});

const isMissingSecret = isMissingStripeResource;

const isPresent = (
  secret: StripeAppsSecret | undefined,
): secret is StripeAppsSecret =>
  secret !== undefined && secret.deleted !== true;

const findByName = (name: string, scope: AppsSecretScope) =>
  GetAppsSecretsFind({
    name,
    scope: toWireScope(scope),
    expand: ["payload"],
  }).pipe(
    Effect.map((secret) => (isPresent(secret) ? secret : undefined)),
    Effect.catchIf(isMissingSecret, () => Effect.succeed(undefined)),
  );

const listByScope = Effect.fn(function* (scope: AppsSecretScope) {
  const secrets: StripeAppsSecret[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetAppsSecrets({
      scope: toWireScope(scope),
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    secrets.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return secrets.filter(isPresent);
});

const observe = Effect.fn(function* (input: {
  id?: string;
  name?: string;
  scope: AppsSecretScope;
}) {
  if (input.name !== undefined) {
    const byName = yield* findByName(input.name, input.scope);
    if (byName !== undefined) return byName;
  }
  if (input.id !== undefined) {
    const secrets = yield* listByScope(input.scope);
    const byId = secrets.find((secret) => secret.id === input.id);
    if (byId !== undefined) {
      const expanded = yield* findByName(
        byId.name,
        fromObservedScope(byId.scope),
      );
      if (expanded !== undefined) return expanded;
      return byId;
    }
  }
  return undefined;
});

const shouldReplace = (
  news: AppsSecretProps,
  output: AppsSecretAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.name !== undefined && news.name !== output.name) return true;
  if (
    news.scope !== undefined &&
    !scopesEqual(toScope(news.scope), output.scope)
  ) {
    return true;
  }
  return false;
};

export const AppsSecretProvider = () =>
  Provider.succeed(AppsSecret, {
    stables: ["name", "scope", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const name =
        output?.name ??
        (typeof olds?.name === "string" ? olds.name : undefined);
      const scope = toScope(
        output?.scope ??
          (olds?.scope !== undefined && typeof olds.scope === "object"
            ? (olds.scope as AppsSecretScope)
            : undefined),
      );
      const existing = yield* observe({
        id: output?.id,
        name,
        scope,
      });
      if (existing === undefined) return undefined;
      // No metadata. Identity is name + scope; a match is treated as owned.
      return toAttrs(existing);
    }),

    list: Effect.fn(function* () {
      // Apps secrets have no metadata. List is account-scoped secrets;
      // user-scoped rows require a user id and are not enumerated. Deleted
      // rows are omitted so they do not re-enter nuke.
      const secrets = yield* listByScope(accountScope());
      return secrets.map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const name = yield* toName(id, news.name, output?.name);
      const scope = toScope(news.scope ?? output?.scope);
      const desiredExpiresAt = news.expiresAt;

      let current = yield* observe({
        id: output?.id,
        name,
        scope,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      const put = (idempotencyKey: string) =>
        CreateAppsSecret({
          name,
          payload: news.payload,
          scope: toWireScope(scope),
          ...(desiredExpiresAt !== undefined
            ? { expires_at: desiredExpiresAt }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey,
          }),
        );

      if (current === undefined) {
        current = yield* put(`alchemy-apps-secret-${instanceId}`).pipe(
          Effect.catchIf(
            (e) => e._tag === "InvalidRequestError" || e._tag === "Conflict",
            (e) =>
              observe({ name, scope }).pipe(
                Effect.flatMap((found) =>
                  found !== undefined ? Effect.succeed(found) : Effect.fail(e),
                ),
              ),
          ),
        );
      }

      if (current === undefined) {
        return yield* new AppsSecretNotResolved({ name });
      }

      const observedPayload = current.payload ?? undefined;
      const payloadChanged =
        observedPayload !== undefined && observedPayload !== news.payload;
      const expiresChanged =
        (current.expires_at ?? undefined) !== desiredExpiresAt;

      if (!payloadChanged && !expiresChanged) {
        return toAttrs(current);
      }

      current = yield* put(`alchemy-apps-secret-${instanceId}-sync`);
      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* CreateAppsSecretsDelete({
        name: output.name,
        scope: toWireScope(output.scope),
      }).pipe(Effect.catchIf(isMissingSecret, () => Effect.void));
    }),
  });
