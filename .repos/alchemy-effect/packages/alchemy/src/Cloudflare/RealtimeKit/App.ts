import * as realtimeKit from "@distilled.cloud/cloudflare/realtime-kit";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.RealtimeKit.App" as const;
type TypeId = typeof TypeId;

export type AppProps = {
  /**
   * Human readable app name. App names are not unique on Cloudflare's side.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID.
   *
   * RealtimeKit currently ships no update API, so the name cannot be changed
   * after creation — and no delete API either, so a name change cannot be
   * modeled as a replacement (the old app could never be removed). Changing
   * this property fails the deploy.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
};

export type AppAttributes = {
  /**
   * Server-generated app identifier (also called the organization id).
   * Stable for the lifetime of the app.
   */
  appId: string;
  /**
   * The Cloudflare account the app belongs to.
   */
  accountId: string;
  /**
   * Human readable app name.
   */
  name: string;
  /**
   * When the app was created.
   */
  createdAt: string;
};

export type App = Resource<TypeId, AppProps, AppAttributes, never, Providers>;

/**
 * A Cloudflare RealtimeKit app — the organizational container for RealtimeKit
 * meetings, presets, and webhooks.
 *
 * RealtimeKit (the acquired Dyte platform) is in beta and must be enabled on
 * the account. The API is create-only today: there is no update and no delete
 * endpoint. Destroying the resource therefore only forgets the app from state
 * (with a warning) — the app itself remains on the account until Cloudflare
 * ships a delete API. Because of this, an existing app with the same name is
 * adopted rather than duplicated.
 * @resource
 * @product Realtime Kit
 * @category Media
 * @section Creating an App
 * @example Basic app
 * ```typescript
 * const app = yield* Cloudflare.RealtimeKit.App("Meetings", {
 *   name: "my-meetings-app",
 * });
 * ```
 *
 * @example Child resources
 * ```typescript
 * const app = yield* Cloudflare.RealtimeKit.App("Meetings", {});
 *
 * const webhook = yield* Cloudflare.RealtimeKit.Webhook("Events", {
 *   appId: app.appId,
 *   url: "https://example.com/webhook",
 *   events: ["meeting.started", "meeting.ended"],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/realtime/realtimekit/
 */
export const App = Resource<App>(TypeId);

/**
 * Returns true if the given value is a App resource.
 */
export const isApp = (value: unknown): value is App =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const AppProvider = () =>
  Provider.succeed(App, {
    stables: ["appId", "accountId", "name", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // No update API and no delete API — a name change can neither be
      // applied in place nor modeled as a replacement (the old app could
      // never be removed). Reconcile fails loudly on a drifted name; diff
      // lets the default update flow surface that error.
      void olds;
      void news;
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.appId) {
        const observed = yield* findById(acct, output.appId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. App names are not unique; an exact match on our
      // generated/explicit name is the best identity we have, and adoption
      // is preferable to orphan-spam since apps cannot be deleted.
      const name = yield* createAppName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? toAttributes(match, acct) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createAppName(id, news.name);

      // Observe — the appId cached on `output` is a hint, not a guarantee.
      // Fall back to a name scan so an existing same-named app is adopted
      // instead of duplicated (apps can never be deleted).
      const observed = output?.appId
        ? yield* findById(output.accountId ?? accountId, output.appId)
        : yield* findByName(accountId, name);

      if (!observed) {
        // Ensure — greenfield: create. Names are not unique so there is no
        // AlreadyExists race to tolerate.
        const created = yield* realtimeKit.postApp({ accountId, name });
        const app = created.data?.app;
        return {
          appId: app?.id ?? "",
          accountId,
          name: app?.name ?? name,
          createdAt: app?.createdAt ?? "",
        };
      }

      // Sync — RealtimeKit has no update API. The only mutable-looking prop
      // is the name; fail loudly instead of silently ignoring drift.
      if ((observed.name ?? "") !== name) {
        return yield* Effect.fail(
          new AppRenameNotSupported({
            appId: observed.id ?? "",
            currentName: observed.name ?? "",
            desiredName: name,
            message: `Cloudflare RealtimeKit apps cannot be renamed (no update API) or replaced (no delete API). App ${observed.id} is named "${observed.name}" but "${name}" was requested.`,
          }),
        );
      }
      return toAttributes(observed, observed.accountId);
    }),
    // No delete API exists, so `delete` cannot actually remove the app — it
    // would re-appear on every `nuke` scan. Skip it in account-wide teardown
    // instead of falsely reporting it deleted.
    nuke: { skip: true },
    delete: Effect.fn(function* ({ output }) {
      // RealtimeKit ships no delete API. Forget the app from state and warn —
      // the app remains on the account until Cloudflare adds deletion.
      yield* Effect.logWarning(
        `Cloudflare RealtimeKit has no delete API — app "${output.name}" (${output.appId}) was removed from state but still exists on account ${output.accountId}.`,
      );
    }),
    // Account-scoped collection: enumerate every RealtimeKit app on the
    // account, exhaustively paginated, and hydrate each into the exact `read`
    // Attributes shape. Unentitled accounts reject the list with the typed
    // `Forbidden` (403) which propagates — the suite gates the live assertion
    // behind an entitlement probe.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const apps = yield* listAllApps(accountId);
      return apps.map((app) => toAttributes({ ...app, accountId }, accountId));
    }),
  });

const LIST_PER_PAGE = 100;

/**
 * Exhaustively enumerate every RealtimeKit app in the account. The list op is
 * not generated as a paginated method, so fetch the first page, derive the
 * page count from `paging.totalCount`, then fan out the remaining pages with
 * bounded concurrency.
 */
const listAllApps = (accountId: string) =>
  Effect.gen(function* () {
    const first = yield* realtimeKit.getApp({
      accountId,
      pageNo: 1,
      perPage: LIST_PER_PAGE,
    });
    const apps = (first.data ?? []).filter(
      (a): a is NonNullable<typeof a> => a !== null,
    );
    const total = first.paging?.totalCount ?? apps.length;
    const pages = Math.ceil(total / LIST_PER_PAGE);
    if (pages <= 1) return apps;
    const rest = yield* Effect.forEach(
      Array.from({ length: pages - 1 }, (_, i) => i + 2),
      (pageNo) =>
        realtimeKit
          .getApp({ accountId, pageNo, perPage: LIST_PER_PAGE })
          .pipe(
            Effect.map((res) =>
              (res.data ?? []).filter(
                (a): a is NonNullable<typeof a> => a !== null,
              ),
            ),
          ),
      { concurrency: 10 },
    );
    return [...apps, ...rest.flat()];
  });

/**
 * Error raised when a deploy attempts to rename a RealtimeKit app. The API
 * has neither an update endpoint (to rename in place) nor a delete endpoint
 * (to model the change as a replacement).
 */
export class AppRenameNotSupported extends Data.TaggedError(
  "AppRenameNotSupported",
)<{
  readonly appId: string;
  readonly currentName: string;
  readonly desiredName: string;
  readonly message: string;
}> {}

type ObservedApp = {
  id?: string | null;
  createdAt?: string | null;
  name?: string | null;
  accountId: string;
};

/**
 * Find an app by id. The API only exposes a list endpoint, so scan it.
 */
const findById = (accountId: string, appId: string) =>
  realtimeKit.getApp({ accountId }).pipe(
    Effect.map((list) =>
      (list.data ?? [])
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a): ObservedApp => ({ ...a, accountId }))
        .find((a) => a.id === appId),
    ),
  );

/**
 * Find an app by exact name. If several apps carry the same name, pick the
 * oldest for determinism.
 */
const findByName = (accountId: string, name: string) =>
  realtimeKit.getApp({ accountId }).pipe(
    Effect.map((list) =>
      (list.data ?? [])
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a): ObservedApp => ({ ...a, accountId }))
        .filter((a) => a.name === name)
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
        .at(0),
    ),
  );

const createAppName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (app: ObservedApp, accountId: string): AppAttributes => ({
  appId: app.id ?? "",
  accountId,
  name: app.name ?? "",
  createdAt: app.createdAt ?? "",
});
