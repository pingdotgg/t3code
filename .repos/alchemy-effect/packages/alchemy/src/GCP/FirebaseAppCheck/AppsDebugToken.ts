import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createOwnership,
  encodeDisplayName,
  expandApp,
  findOwnedDebugToken,
  getDebugToken,
  listDebugTokensForApp,
  listOwnedDebugTokens,
  ownedByAlchemy,
  parseDebugTokenName,
  parseDisplayName,
  replaceOnIdentity,
  ResourceNotResolved,
  retryTransient,
  sameText,
  sameTextInsensitive,
  toDisplayName,
  toToken,
} from "./internal.ts";

export type AppsDebugTokenProps = {
  /**
   * Firebase App id (`1:123:web:abc`) or full resource name
   * `projects/{project}/apps/{appId}`. Immutable — changing it replaces
   * the debug token.
   */
  app: string;
  /**
   * Human-readable display name. Debug tokens have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  displayName?: string;
  /**
   * Secret token. Must be a UUID4 (case insensitive). If omitted, a UUID4
   * is generated and stored in Alchemy state. Input-only on the GCP API
   * — never returned by get/list. Immutable — changing it replaces the
   * debug token. Each app may have at most 20 debug tokens.
   */
  token?: string;
};

export type AppsDebugToken = Resource<
  "GCP.FirebaseAppCheck.AppsDebugToken",
  AppsDebugTokenProps,
  {
    /** Full resource name. */
    name: string;
    /** Server-assigned debug token id (last path segment). */
    debugTokenId: string;
    /** Parent app resource `projects/{project}/apps/{appId}`. */
    app: string;
    /** Firebase App id. */
    appId: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /**
     * Secret token from create input / Alchemy state. Never populated by
     * the App Check API after create.
     */
    token: string | undefined;
    /** Server-assigned checksum for optimistic concurrency. */
    etag: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Firebase App Check debug token. Debug tokens let development and
 * integration testing bypass app attestation while App Check still
 * protects production Firebase services.
 *
 * Debug tokens have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. `app` and `token` are identity —
 * changing either replaces the token. Display name updates in place.
 * GCP never returns `token` after create; Alchemy stores the secret in
 * state so {@link ExchangeDebugToken} can redeem it.
 *
 * ### Creating a Debug Token
 * **Example:** Generated UUID
 * ```typescript
 * const debug = yield* GCP.FirebaseAppCheck.AppsDebugToken("Local", {
 *   app: "1:123:web:abc",
 *   displayName: "ios simulator",
 * });
 * ```
 *
 * **Example:** Explicit UUID4
 * ```typescript
 * const debug = yield* GCP.FirebaseAppCheck.AppsDebugToken("Local", {
 *   app: "1:123:web:abc",
 *   displayName: "android emulator",
 *   token: "123e4567-e89b-12d3-a456-426614174000",
 * });
 * ```
 *
 * ### Updating a Debug Token
 * **Example:** Rename
 * ```typescript
 * const debug = yield* GCP.FirebaseAppCheck.AppsDebugToken("Local", {
 *   displayName: "ci runner",
 * });
 * ```
 *
 * ### Exchanging a Debug Token
 * **Example:** Mint an App Check token
 * ```typescript
 * const exchange = yield* GCP.FirebaseAppCheck.ExchangeDebugToken(debug);
 * const { token, ttl } = yield* exchange();
 * ```
 *
 * @resource
 * @category FirebaseAppCheck
 */
export const AppsDebugToken = Resource<AppsDebugToken>(
  "GCP.FirebaseAppCheck.AppsDebugToken",
);

const getByName = getDebugToken;

const toAttrs = (
  token: firebaseappcheck.GoogleFirebaseAppcheckV1DebugToken,
  project: string,
  secret: string | undefined,
): AppsDebugToken["Attributes"] => {
  const name = token.name ?? "";
  const parsed = parseDebugTokenName(name);
  const { displayName } = parseDisplayName(token.displayName);
  return {
    name,
    debugTokenId: parsed.debugTokenId,
    app: parsed.app,
    appId: parsed.appId,
    project: parsed.project || project,
    displayName,
    token: secret,
    etag: token.etag,
    updateTime: token.updateTime,
  };
};

export const AppsDebugTokenProvider = () =>
  Provider.succeed(AppsDebugToken, {
    stables: ["name", "debugTokenId", "app", "appId", "project", "token"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousApp = expandApp(
        env.project,
        olds?.app ?? output?.app ?? "",
      );
      const nextApp = expandApp(env.project, news.app);
      return replaceOnIdentity({
        previous: previousApp.length > 0 ? previousApp : undefined,
        next: nextApp,
        extra:
          news.token !== undefined &&
          (output?.token ?? olds?.token) !== undefined &&
          !sameTextInsensitive(news.token, output?.token ?? olds?.token),
        deleteFirst: true,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      let existing = yield* getByName(output?.name ?? "");
      if (existing === undefined && olds?.app) {
        const app = expandApp(env.project, olds.app);
        existing = yield* findOwnedDebugToken(
          yield* listDebugTokensForApp(app),
          id,
          output?.name,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, output?.token);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const tokens = yield* listOwnedDebugTokens(env.project);
        return tokens.map((token) => toAttrs(token, env.project, undefined));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const app = expandApp(env.project, news.app);
      const ownership = yield* createOwnership(id);
      const userDisplay = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const desiredDisplay = encodeDisplayName(ownership, userDisplay);
      const secret = yield* toToken(news.token, output?.token);

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findOwnedDebugToken(
          yield* listDebugTokensForApp(app),
          id,
          output?.name,
        );
      }

      if (current === undefined) {
        const created = yield* retryTransient(
          firebaseappcheck.createProjectsAppsDebugTokens({
            parent: app,
            body: {
              displayName: desiredDisplay,
              token: secret,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () =>
            listDebugTokensForApp(app).pipe(
              Effect.flatMap((tokens) =>
                findOwnedDebugToken(tokens, id, output?.name),
              ),
            ),
          ),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: output?.name ?? `${app}/debugTokens`,
        });
      }

      if (!sameText(current.displayName, desiredDisplay)) {
        current = yield* retryTransient(
          firebaseappcheck.patchProjectsAppsDebugTokens({
            name: current.name ?? "",
            updateMask: "display_name",
            body: {
              displayName: desiredDisplay,
              etag: current.etag,
            },
          }),
        );
      }

      return toAttrs(current, env.project, secret);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        firebaseappcheck.deleteProjectsAppsDebugTokens({
          name: output.name,
          etag: output.etag,
        }),
      ).pipe(
        Effect.catchTag("Conflict", () =>
          firebaseappcheck.deleteProjectsAppsDebugTokens({
            name: output.name,
          }),
        ),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
