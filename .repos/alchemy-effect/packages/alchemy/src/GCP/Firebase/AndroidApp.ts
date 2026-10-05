import * as firebase from "@distilled.cloud/gcp/firebase_v1beta1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  hasOwnershipMarker,
  lastSegment,
  listAndroidApps,
  ownedByAlchemy,
  ownedDisplayName,
  packageNameOf,
  parseDisplayName,
  projectParent,
  ResourceNotResolved,
  waitForOperation,
} from "./internal.ts";

export type AndroidAppProps = {
  /**
   * Canonical Android package name (`com.example.app`). Immutable —
   * changing it replaces the app. If omitted, a unique
   * `com.alchemy.test.{id}` name is generated.
   */
  packageName?: string;
  /**
   * User-assigned display name. Android apps have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  displayName?: string;
  /**
   * SHA-1 certificate hashes.
   */
  sha1Hashes?: string[];
  /**
   * SHA-256 certificate hashes.
   */
  sha256Hashes?: string[];
  /**
   * Google-assigned API key uid. Firebase associates one automatically
   * when omitted.
   */
  apiKeyId?: string;
};

export type AndroidApp = Resource<
  "GCP.Firebase.AndroidApp",
  AndroidAppProps,
  {
    /** Full resource name `projects/{project}/androidApps/{appId}`. */
    name: string;
    /** Firebase-assigned app id. */
    appId: string;
    /** Parent project id. */
    projectId: string;
    /** Android package name. */
    packageName: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** SHA-1 hashes. */
    sha1Hashes: string[] | undefined;
    /** SHA-256 hashes. */
    sha256Hashes: string[] | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** Associated API key uid. */
    apiKeyId: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** Expire time when the app is in `DELETED`. */
    expireTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Firebase Android app in a Firebase project.
 *
 * Apps have no labels — Alchemy stamps ownership into `displayName`.
 * `packageName` is immutable. Delete uses `androidApps.remove` with
 * `immediate: true` so tests do not leave a 30-day tombstone.
 *
 * ### Creating an Android App
 * **Example:** Generated package name
 * ```typescript
 * const app = yield* GCP.Firebase.AndroidApp("Mobile", {
 *   displayName: "mobile",
 * });
 * ```
 *
 * **Example:** Explicit package
 * ```typescript
 * const app = yield* GCP.Firebase.AndroidApp("Mobile", {
 *   packageName: "com.example.mobile",
 *   displayName: "mobile",
 * });
 * ```
 *
 * @resource
 * @category Firebase
 */
export const AndroidApp = Resource<AndroidApp>("GCP.Firebase.AndroidApp");

const toAttrs = (app: firebase.AndroidApp) => ({
  name: app.name ?? "",
  appId: app.appId ?? lastSegment(app.name ?? ""),
  projectId: app.projectId ?? "",
  packageName: app.packageName,
  displayName: parseDisplayName(app.displayName).displayName,
  sha1Hashes: app.sha1Hashes,
  sha256Hashes: app.sha256Hashes,
  state: app.state,
  apiKeyId: app.apiKeyId,
  etag: app.etag,
  expireTime: app.expireTime,
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : firebase
        .getProjectsAndroidApps({ name })
        .pipe(
          Effect.catchTag(["NotFound", "AndroidAppNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );

const findOwned = (
  project: string,
  displayName: string,
  packageName?: string,
) =>
  listAndroidApps(project).pipe(
    Effect.map((apps) =>
      apps.find(
        (app) =>
          app.displayName === displayName ||
          (packageName !== undefined && app.packageName === packageName),
      ),
    ),
  );

const sameList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());

export const AndroidAppProvider = () =>
  Provider.succeed(AndroidApp, {
    stables: ["name", "appId", "projectId", "packageName"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPackage = olds?.packageName ?? output?.packageName;
      if (
        previousPackage !== undefined &&
        news.packageName !== undefined &&
        news.packageName !== previousPackage
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      let existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) {
        const displayName = yield* ownedDisplayName(
          id,
          olds?.displayName,
          parseDisplayName(output?.displayName).displayName,
        );
        existing = yield* findOwned(
          env.project,
          displayName,
          olds?.packageName ?? output?.packageName,
        );
      }
      if (existing === undefined || existing.state === "DELETED") {
        return undefined;
      }
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const apps = yield* listAndroidApps(env.project);
        return apps
          .filter(
            (app) =>
              hasOwnershipMarker(app.displayName) && app.state !== "DELETED",
          )
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const displayName = yield* ownedDisplayName(
        id,
        news.displayName,
        parseDisplayName(output?.displayName).displayName,
      );
      const packageName = yield* packageNameOf(
        id,
        news.packageName,
        output?.packageName,
      );

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findOwned(env.project, displayName, packageName);
      }

      if (current === undefined) {
        const operation = yield* firebase
          .createProjectsAndroidApps({
            parent: projectParent(env.project),
            body: {
              packageName,
              displayName,
              sha1Hashes: news.sha1Hashes,
              sha256Hashes: news.sha256Hashes,
              apiKeyId: news.apiKeyId,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(env.project, displayName, packageName).pipe(
                Effect.map((app) =>
                  app
                    ? ({
                        done: true,
                        response: { name: app.name },
                      } satisfies firebase.Operation)
                    : undefined,
                ),
              ),
            ),
          );
        if (operation) {
          const done = yield* waitForOperation(operation);
          const name =
            (typeof done.response?.name === "string"
              ? done.response.name
              : undefined) ??
            output?.name ??
            "";
          current =
            (yield* getByName(name)) ??
            (yield* findOwned(env.project, displayName, packageName));
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: output?.name ?? packageName,
        });
      }

      const name = current.name ?? "";
      const displayChanged = current.displayName !== displayName;
      const sha1Changed =
        news.sha1Hashes !== undefined &&
        !sameList(current.sha1Hashes, news.sha1Hashes);
      const sha256Changed =
        news.sha256Hashes !== undefined &&
        !sameList(current.sha256Hashes, news.sha256Hashes);
      const apiKeyChanged =
        news.apiKeyId !== undefined && current.apiKeyId !== news.apiKeyId;
      const updateMask = [
        displayChanged ? "displayName" : undefined,
        sha1Changed ? "sha1Hashes" : undefined,
        sha256Changed ? "sha256Hashes" : undefined,
        apiKeyChanged ? "apiKeyId" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* firebase.patchProjectsAndroidApps({
          name,
          updateMask: updateMask.join(","),
          body: {
            displayName,
            sha1Hashes: news.sha1Hashes,
            sha256Hashes: news.sha256Hashes,
            apiKeyId: news.apiKeyId,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* firebase
        .removeProjectsAndroidApps({
          name: output.name,
          body: { immediate: true, allowMissing: true },
        })
        .pipe(
          Effect.catchTag(["NotFound", "AndroidAppNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation) {
        yield* waitForOperation(operation).pipe(
          Effect.catchIf(
            (error) => error._tag === "GCP.OperationFailed" && error.code === 5,
            () => Effect.void,
          ),
        );
      }
    }),
  });
