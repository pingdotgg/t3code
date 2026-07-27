import * as calls from "@distilled.cloud/cloudflare/calls";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Calls.TurnKey" as const;
type TypeId = typeof TypeId;

export type TurnKeyProps = {
  /**
   * A short description of the TURN key, not shown to end users and not
   * unique. Mutable in place. If omitted, a unique name is generated from
   * the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
};

export type TurnKeyAttributes = {
  /**
   * Cloudflare-generated unique identifier for the TURN key. Used in the
   * credential-minting API path
   * (`https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate`).
   */
  keyId: string;
  /**
   * The Cloudflare account the TURN key belongs to.
   */
  accountId: string;
  /**
   * TURN key secret (bearer token) used to mint short-lived TURN
   * credentials. Returned only at creation time and never re-readable —
   * Alchemy persists it in state and carries it forward across updates.
   */
  key: Redacted.Redacted<string>;
  /**
   * A short description of the TURN key.
   */
  name: string;
  /**
   * When the TURN key was created.
   */
  created: string;
  /**
   * When the TURN key was last modified.
   */
  modified: string;
};

export type TurnKey = Resource<
  TypeId,
  TurnKeyProps,
  TurnKeyAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Realtime (formerly "Calls") TURN key.
 *
 * A TURN key authenticates your backend against Cloudflare's managed TURN
 * service: you exchange the create-only `key` (a bearer token) for
 * short-lived TURN credentials that WebRTC clients use to relay traffic
 * through Cloudflare's network. The only configurable property is the
 * human-readable `name`, which is mutable in place.
 * @resource
 * @product Calls
 * @category Media
 * @section Creating a TURN key
 * @example TURN key with a generated name
 * ```typescript
 * const turnKey = yield* Cloudflare.Calls.TurnKey("turn", {});
 * ```
 *
 * @example TURN key with an explicit name
 * ```typescript
 * const turnKey = yield* Cloudflare.Calls.TurnKey("turn", {
 *   name: "my-turn-key",
 * });
 * ```
 *
 * @section Using the key
 * @example Minting TURN credentials server-side
 * ```typescript
 * // keyId is public — it appears in the credential-minting URL:
 * const keyId = turnKey.keyId;
 *
 * // The key is redacted — POST it as a bearer token to
 * // https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate
 * const apiToken = turnKey.key; // Redacted<string>
 * ```
 *
 * @see https://developers.cloudflare.com/realtime/turn/
 */
export const TurnKey = Resource<TurnKey>(TypeId);

/**
 * Returns true if the given value is a TurnKey resource.
 */
export const isTurnKey = (value: unknown): value is TurnKey =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const TurnKeyProvider = () =>
  Provider.succeed(TurnKey, {
    stables: ["keyId", "accountId", "key", "created"],
    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      // The TURN key secret is returned only at creation time, so a key
      // cannot be re-hydrated without prior state — no cold read /
      // adoption path.
      if (!output?.keyId) return undefined;
      const observed = yield* getTurnKey(output.accountId, output.keyId);
      return observed
        ? toAttributes(observed, output.accountId, output.key)
        : undefined;
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection: paginate the TURN keys list exhaustively.
      // The list response carries every readable field (uid/name/created/
      // modified) — the bearer `key` is returned only at creation and is
      // never re-readable, so we hydrate it as an empty redacted value to
      // match exactly what `read` would produce on a cold (stateless) read.
      return yield* calls.listTurns.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((turnKey) =>
              toAttributes(turnKey, accountId, Redacted.make("")),
            ),
          ),
        ),
      );
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createTurnKeyName(id, news.name);

      // Observe — the keyId cached on `output` is a hint, not a guarantee:
      // a missing key (code 20008) falls through and we recreate.
      const observed = output?.keyId
        ? yield* getTurnKey(output.accountId ?? accountId, output.keyId)
        : undefined;

      if (!observed || !output) {
        // Ensure — greenfield (or out-of-band delete): create and capture
        // the create-only key. Names are not unique on Cloudflare's side,
        // so there is no AlreadyExists race to tolerate.
        const created = yield* calls.createTurn({ accountId, name });
        return toAttributes(
          created,
          accountId,
          Redacted.make(created.key ?? ""),
        );
      }

      // Sync — the only mutable aspect is `name`; diff observed cloud
      // state against desired and skip the PUT entirely on a no-op.
      if (observed.name === name) {
        return toAttributes(observed, output.accountId, output.key);
      }
      const updated = yield* calls.updateTurn({
        accountId: output.accountId,
        keyId: output.keyId,
        name,
      });
      return toAttributes(updated, output.accountId, output.key);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* calls
        .deleteTurn({ accountId: output.accountId, keyId: output.keyId })
        .pipe(Effect.catchTag("TurnKeyNotFound", () => Effect.void));
    }),
  });

/**
 * Read a TURN key by id, mapping "gone" (`TurnKeyNotFound`, Cloudflare
 * error code 20008) to `undefined`.
 */
const getTurnKey = (accountId: string, keyId: string) =>
  calls
    .getTurn({ accountId, keyId })
    .pipe(Effect.catchTag("TurnKeyNotFound", () => Effect.succeed(undefined)));

const createTurnKeyName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  turnKey:
    | calls.GetTurnResponse
    | calls.CreateTurnResponse
    | calls.UpdateTurnResponse,
  accountId: string,
  key: Redacted.Redacted<string>,
): TurnKeyAttributes => ({
  keyId: turnKey.uid ?? "",
  accountId,
  key,
  name: turnKey.name ?? "",
  created: turnKey.created ?? "",
  modified: turnKey.modified ?? "",
});
