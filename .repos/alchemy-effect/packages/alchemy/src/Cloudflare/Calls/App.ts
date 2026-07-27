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

const TypeId = "Cloudflare.Calls.App" as const;
type TypeId = typeof TypeId;

export type AppProps = {
  /**
   * A short description of the app, not shown to end users and not unique.
   * Mutable in place. If omitted, a unique name is generated from the app,
   * stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
};

export type AppAttributes = {
  /**
   * Cloudflare-generated unique identifier for the app. Used in client SDK
   * session URLs (`https://rtc.live.cloudflare.com/v1/apps/{appId}/...`).
   */
  appId: string;
  /**
   * The Cloudflare account the app belongs to.
   */
  accountId: string;
  /**
   * App secret (bearer token) used to authenticate against the Realtime SFU
   * HTTPS API. Returned only at creation time and never re-readable — Alchemy
   * persists it in state and carries it forward across updates.
   */
  secret: Redacted.Redacted<string>;
  /**
   * A short description of the app.
   */
  name: string;
  /**
   * When the app was created.
   */
  created: string;
  /**
   * When the app was last modified.
   */
  modified: string;
};

export type App = Resource<TypeId, AppProps, AppAttributes, never, Providers>;

/**
 * A Cloudflare Realtime (formerly "Calls") SFU application.
 *
 * An app is the unit of isolation for Cloudflare's WebRTC SFU: clients
 * connect to sessions scoped to the app's auto-assigned `appId`, and your
 * backend authenticates management calls with the create-only `secret`
 * (a bearer token). The only configurable property is the human-readable
 * `name`, which is mutable in place.
 * @resource
 * @product Calls
 * @category Media
 * @section Creating an App
 * @example App with a generated name
 * ```typescript
 * const app = yield* Cloudflare.Calls.App("realtime", {});
 * ```
 *
 * @example App with an explicit name
 * ```typescript
 * const app = yield* Cloudflare.Calls.App("realtime", {
 *   name: "my-realtime-app",
 * });
 * ```
 *
 * @section Using the credentials
 * @example Passing the appId and secret to a backend
 * ```typescript
 * // appId is public — it appears in client session URLs:
 * const appId = app.appId;
 *
 * // The secret is redacted — use it server-side as a bearer token
 * // against https://rtc.live.cloudflare.com/v1/apps/{appId}/...
 * const secret = app.secret; // Redacted<string>
 * ```
 *
 * @see https://developers.cloudflare.com/realtime/
 */
export const App = Resource<App>(TypeId);

/**
 * Returns true if the given value is a App resource.
 */
export const isApp = (value: unknown): value is App =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const AppProvider = () =>
  Provider.succeed(App, {
    stables: ["appId", "accountId", "secret", "created"],
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection: enumerate every Calls app under the
      // account, exhaustively paginating `result`. The create-only secret
      // is never returned by the list endpoint, so — matching `read` for a
      // resource without prior state — hydrate it as an empty Redacted.
      return yield* calls.listSfus.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((app) =>
              toAttributes(app, accountId, Redacted.make("")),
            ),
          ),
        ),
      );
    }),
    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      // The app secret is returned only at creation time, so an app cannot
      // be re-hydrated without prior state — no cold read / adoption path.
      if (!output?.appId) return undefined;
      const observed = yield* getApp(output.accountId, output.appId);
      return observed
        ? toAttributes(observed, output.accountId, output.secret)
        : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createAppName(id, news.name);

      // Observe — the appId cached on `output` is a hint, not a guarantee:
      // a missing app (code 20007) falls through and we recreate.
      const observed = output?.appId
        ? yield* getApp(output.accountId ?? accountId, output.appId)
        : undefined;

      if (!observed || !output) {
        // Ensure — greenfield (or out-of-band delete): create and capture
        // the create-only secret. Names are not unique on Cloudflare's
        // side, so there is no AlreadyExists race to tolerate.
        const created = yield* calls.createSfu({ accountId, name });
        return toAttributes(
          created,
          accountId,
          Redacted.make(created.secret ?? ""),
        );
      }

      // Sync — the only mutable aspect is `name`; diff observed cloud
      // state against desired and skip the PUT entirely on a no-op.
      if (observed.name === name) {
        return toAttributes(observed, output.accountId, output.secret);
      }
      const updated = yield* calls.updateSfu({
        accountId: output.accountId,
        appId: output.appId,
        name,
      });
      return toAttributes(updated, output.accountId, output.secret);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* calls
        .deleteSfu({ accountId: output.accountId, appId: output.appId })
        .pipe(Effect.catchTag("CallsAppNotFound", () => Effect.void));
    }),
  });

/**
 * Read an app by id, mapping "gone" (`CallsAppNotFound`, Cloudflare error
 * code 20007) to `undefined`.
 */
const getApp = (accountId: string, appId: string) =>
  calls
    .getSfu({ accountId, appId })
    .pipe(Effect.catchTag("CallsAppNotFound", () => Effect.succeed(undefined)));

const createAppName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  app: calls.GetSfuResponse | calls.CreateSfuResponse | calls.UpdateSfuResponse,
  accountId: string,
  secret: Redacted.Redacted<string>,
): AppAttributes => ({
  appId: app.uid ?? "",
  accountId,
  secret,
  name: app.name ?? "",
  created: app.created ?? "",
  modified: app.modified ?? "",
});
