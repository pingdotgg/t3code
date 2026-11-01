import * as apikeys from "@distilled.cloud/gcp/apikeys_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  waitForOperation as waitForLongRunning,
  type LongRunningOperation,
} from "../Operation.ts";

const LOCATION = "global";
const MAX_NAME_LENGTH = 63;

export type ApiTarget = {
  /**
   * Canonical service name, e.g. `translate.googleapis.com`.
   */
  service?: string;
  /**
   * Allowed methods. Empty means all methods for `service`. A trailing
   * `*` wildcard is allowed (`Get*`).
   */
  methods?: string[];
};

export type BrowserKeyRestrictions = {
  /**
   * Referrer URL regular expressions allowed to call with this key.
   */
  allowedReferrers?: string[];
};

export type AndroidApplication = {
  /**
   * SHA-1 fingerprint of the app signing cert. Colon-separated and
   * compact hex are both accepted; the API stores the compact form.
   */
  sha1Fingerprint?: string;
  /**
   * Android application package name.
   */
  packageName?: string;
};

export type AndroidKeyRestrictions = {
  /**
   * Android apps allowed to call with this key.
   */
  allowedApplications?: AndroidApplication[];
};

export type ServerKeyRestrictions = {
  /**
   * Caller IP addresses (or CIDRs) allowed to call with this key.
   */
  allowedIps?: string[];
};

export type IosKeyRestrictions = {
  /**
   * iOS bundle IDs allowed to call with this key.
   */
  allowedBundleIds?: string[];
};

export type KeyRestrictions = {
  /**
   * Allowed API targets. Empty / omitted allows every enabled service.
   */
  apiTargets?: ApiTarget[];
  /**
   * HTTP referrer restrictions. Mutually exclusive with android, iOS,
   * and server restrictions.
   */
  browserKeyRestrictions?: BrowserKeyRestrictions;
  /**
   * Android app restrictions. Mutually exclusive with browser, iOS, and
   * server restrictions.
   */
  androidKeyRestrictions?: AndroidKeyRestrictions;
  /**
   * Caller IP restrictions. Mutually exclusive with browser, Android,
   * and iOS restrictions.
   */
  serverKeyRestrictions?: ServerKeyRestrictions;
  /**
   * iOS bundle-id restrictions. Mutually exclusive with browser,
   * Android, and server restrictions.
   */
  iosKeyRestrictions?: IosKeyRestrictions;
};

export type KeyProps = {
  /**
   * Key id (the `{key}` segment of
   * `projects/{project}/locations/global/keys/{key}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Must match `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`, must not be UUID-like,
   * and is immutable — changing it replaces the key.
   */
  keyId?: string;
  /**
   * Human-readable display name. Max 63 characters.
   */
  displayName?: string;
  /**
   * User annotations. API keys have no labels field — Alchemy ownership
   * (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored here
   * so `list` / `pnpm nuke:gcp` can find owned keys. User keys are
   * preserved; Alchemy keys win on conflict.
   */
  annotations?: Record<string, string>;
  /**
   * Key restrictions (API targets and client-type limits).
   */
  restrictions?: KeyRestrictions;
  /**
   * Service account the key is bound to. Immutable — changing it
   * replaces the key. Binding enables service-account auth on the key.
   */
  serviceAccountEmail?: string;
};

export type Key = Resource<
  "GCP.ApiKeys.Key",
  KeyProps,
  {
    /** Full resource name `projects/{project}/locations/global/keys/{key}`. */
    name: string;
    /** Key id (last path segment). */
    keyId: string;
    /** Project id. */
    project: string;
    /** Always `global` — API keys are a global resource. */
    location: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** Key restrictions currently configured. */
    restrictions: KeyRestrictions | undefined;
    /** Bound service account email, if any. */
    serviceAccountEmail: string | undefined;
    /**
     * Encrypted key string. Empty on `list` (nuke does not need it).
     * Fetch at runtime with {@link GetKeyString}.
     */
    keyString: string | undefined;
    /** Server-assigned UUID4, stable until delete. */
    uid: string | undefined;
    /** Server checksum of the resource. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud API key (the API Keys API, `apikeys.googleapis.com`).
 *
 * Keys are global (`locations/global`). They have no labels — Alchemy
 * stamps ownership into `annotations` so `read`, `list`, and
 * `pnpm nuke:gcp` can find them. `keyId` and `serviceAccountEmail` are
 * immutable; changing either replaces the key. Deletes are soft: the key
 * can be undeleted for 30 days, then it is purged.
 *
 * ### Creating a Key
 * **Example:** Generated name
 * ```typescript
 * const maps = yield* GCP.ApiKeys.Key("Maps", {
 *   displayName: "maps browser key",
 * });
 * ```
 *
 * **Example:** Named key with annotations and API-target restrictions
 * ```typescript
 * const maps = yield* GCP.ApiKeys.Key("Maps", {
 *   keyId: "maps-browser",
 *   displayName: "maps browser key",
 *   annotations: { env: "prod" },
 *   restrictions: {
 *     apiTargets: [{ service: "geocoding-backend.googleapis.com" }],
 *     browserKeyRestrictions: {
 *       allowedReferrers: ["https://example.com/*"],
 *     },
 *   },
 * });
 * ```
 *
 * ### Reading the Key String
 * **Example:** Get the encrypted key string at runtime
 * ```typescript
 * const getKeyString = yield* GCP.ApiKeys.GetKeyString(maps);
 * const { keyString } = yield* getKeyString();
 * ```
 *
 * @resource
 * @category ApiKeys
 */
export const Key = Resource<Key>("GCP.ApiKeys.Key");

export class KeyNotResolved extends Data.TaggedError(
  "GCP.ApiKeys.KeyNotResolved",
)<{
  name: string;
}> {}

export class KeyStillExists extends Data.TaggedError(
  "GCP.ApiKeys.KeyStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `k${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "apikey";
};

const resourceName = (project: string, keyId: string) =>
  `projects/${project}/locations/${LOCATION}/keys/${keyId}`;

const parentOf = (project: string) =>
  `projects/${project}/locations/${LOCATION}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const keysAt = parts.lastIndexOf("keys");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    keyId:
      keysAt >= 0 && parts[keysAt + 1] ? parts[keysAt + 1]! : lastSegment(name),
  };
};

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(annotations));

const toId = (id: string, keyId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (keyId !== undefined) return keyId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const isDeleted = (key: apikeys.V2Key | undefined) =>
  (key?.deleteTime ?? "") !== "";

const toRestrictions = (
  restrictions: apikeys.V2Restrictions | undefined,
): KeyRestrictions | undefined => {
  if (restrictions === undefined) return undefined;
  if (
    (restrictions.apiTargets?.length ?? 0) === 0 &&
    restrictions.browserKeyRestrictions === undefined &&
    restrictions.androidKeyRestrictions === undefined &&
    restrictions.serverKeyRestrictions === undefined &&
    restrictions.iosKeyRestrictions === undefined
  ) {
    return undefined;
  }
  return {
    apiTargets: restrictions.apiTargets,
    browserKeyRestrictions: restrictions.browserKeyRestrictions,
    androidKeyRestrictions: restrictions.androidKeyRestrictions,
    serverKeyRestrictions: restrictions.serverKeyRestrictions,
    iosKeyRestrictions: restrictions.iosKeyRestrictions,
  };
};

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort((a, b) => a.localeCompare(b));

const fingerprintSha1 = (value: string | undefined) =>
  (value ?? "").replace(/:/g, "").toUpperCase();

const restrictionsFingerprint = (
  restrictions: KeyRestrictions | undefined,
): string => {
  if (restrictions === undefined) return "";
  const apiTargets = [...(restrictions.apiTargets ?? [])]
    .map((target) => ({
      service: target.service ?? "",
      methods: sorted(target.methods),
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
  const android = [
    ...(restrictions.androidKeyRestrictions?.allowedApplications ?? []),
  ]
    .map((app) => ({
      packageName: app.packageName ?? "",
      sha1Fingerprint: fingerprintSha1(app.sha1Fingerprint),
    }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
  return JSON.stringify({
    apiTargets,
    browser: restrictions.browserKeyRestrictions
      ? {
          allowedReferrers: sorted(
            restrictions.browserKeyRestrictions.allowedReferrers,
          ),
        }
      : undefined,
    android: restrictions.androidKeyRestrictions
      ? { allowedApplications: android }
      : undefined,
    server: restrictions.serverKeyRestrictions
      ? {
          allowedIps: sorted(restrictions.serverKeyRestrictions.allowedIps),
        }
      : undefined,
    ios: restrictions.iosKeyRestrictions
      ? {
          allowedBundleIds: sorted(
            restrictions.iosKeyRestrictions.allowedBundleIds,
          ),
        }
      : undefined,
  });
};

const toAttrs = (
  key: apikeys.V2Key,
  project: string,
  keyString?: string,
): Key["Attributes"] => {
  const name = key.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    keyId: parsed.keyId,
    project: parsed.project || project,
    location: LOCATION,
    displayName: key.displayName,
    annotations: userAnnotations(key.annotations),
    restrictions: toRestrictions(key.restrictions),
    serviceAccountEmail: key.serviceAccountEmail,
    keyString,
    uid: key.uid,
    etag: key.etag,
    createTime: key.createTime,
    updateTime: key.updateTime,
  };
};

const getByName = (name: string) =>
  apikeys
    .getProjectsLocationsKeys({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getKeyStringValue = (name: string) =>
  apikeys.getKeyStringProjectsLocationsKeys({ name }).pipe(
    Effect.map((response) => response.keyString),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const toAttrsLive = (key: apikeys.V2Key, project: string) =>
  Effect.gen(function* () {
    const name = key.name ?? "";
    const keyString =
      name.length > 0 ? yield* getKeyStringValue(name) : undefined;
    return toAttrs(key, project, keyString);
  });

const waitUntilActive = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((key) =>
      key && !isDeleted(key)
        ? Effect.succeed(key)
        : Effect.fail(new KeyNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ApiKeys.KeyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((key) =>
      key === undefined || isDeleted(key)
        ? Effect.void
        : Effect.fail(new KeyStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ApiKeys.KeyStillExists",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const reviveDeleted = (name: string) =>
  Effect.gen(function* () {
    const operation = yield* apikeys
      .undeleteProjectsLocationsKeys({ name, body: {} })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (operation !== undefined) {
      yield* waitForOperation(operation);
    }
    return yield* getByName(name);
  });

const listOwnedKeys = (project: string) =>
  apikeys.listProjectsLocationsKeys
    .pages({
      parent: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.keys ?? [])),
      Stream.filter(
        (key) =>
          !isDeleted(key) &&
          Object.keys(key.annotations ?? {}).some((item) =>
            item.startsWith("alchemy-"),
          ),
      ),
      Stream.map((key) => toAttrs(key, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCreateBody = (
  news: KeyProps,
  annotations: Record<string, string>,
): apikeys.V2Key => ({
  displayName: news.displayName,
  annotations,
  restrictions: news.restrictions,
  serviceAccountEmail: news.serviceAccountEmail,
});

export const KeyProvider = () =>
  Provider.succeed(Key, {
    stables: ["name", "keyId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.keyId ?? output?.keyId;
      const nextId = news.keyId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;
      const previousSa =
        olds?.serviceAccountEmail ?? output?.serviceAccountEmail ?? "";
      const nextSa = news.serviceAccountEmail ?? previousSa;
      const saChanged = previousSa !== nextSa;

      if (!idChanged && !saChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          !idChanged && previousId !== undefined && nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const keyId = yield* toId(id, olds?.keyId, output?.keyId);
      const name = output?.name ?? resourceName(env.project, keyId);
      const existing = yield* getByName(name);
      if (existing === undefined || isDeleted(existing)) return undefined;
      const attrs = yield* toAttrsLive(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.annotations)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwnedKeys(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const keyId = yield* toId(id, news.keyId, output?.keyId);
      const name = resourceName(env.project, keyId);
      const parent = parentOf(env.project);
      const desiredAnnotations = {
        ...toLabels(news.annotations),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current !== undefined && isDeleted(current)) {
        current = yield* reviveDeleted(name);
      }

      if (current === undefined || isDeleted(current)) {
        const created = yield* apikeys
          .createProjectsLocationsKeys({
            parent,
            keyId,
            body: toCreateBody(news, desiredAnnotations),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* getByName(name);
        if (current !== undefined && isDeleted(current)) {
          current = yield* reviveDeleted(name);
        }
        if (current === undefined || isDeleted(current)) {
          current = yield* waitUntilActive(name);
        }
      }

      if (current === undefined || isDeleted(current)) {
        return yield* new KeyNotResolved({ name });
      }

      const observedAnnotations = tagRecord(current.annotations);
      const { upsert, removed } = diffLabels(
        observedAnnotations,
        desiredAnnotations,
      );
      const annotationsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const restrictionsChanged =
        restrictionsFingerprint(toRestrictions(current.restrictions)) !==
        restrictionsFingerprint(news.restrictions);

      if (annotationsChanged || displayNameChanged || restrictionsChanged) {
        const updateMask = [
          annotationsChanged ? "annotations" : undefined,
          displayNameChanged ? "display_name" : undefined,
          restrictionsChanged ? "restrictions" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation = yield* apikeys.patchProjectsLocationsKeys({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            etag: current.etag,
            annotations: desiredAnnotations,
            displayName: news.displayName,
            restrictions: news.restrictions ?? {},
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilActive(name);
      }

      return yield* toAttrsLive(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apikeys
        .deleteProjectsLocationsKeys({
          name: output.name,
          etag: output.etag,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(output.name);
    }),
  });

/** API key operations finish within seconds. */
const OPERATION_BUDGET = "5 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(operation, (name) => apikeys.getOperations({ name }), {
    budget: OPERATION_BUDGET,
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === "GCP.OperationFailed" && error.code === 6,
      () => Effect.succeed(operation),
    ),
  );

/**
 * Wait for a delete operation. A vanished operation or NOT_FOUND (code 5)
 * means the resource is already gone.
 */
const waitForDeleteOperation = (operation: LongRunningOperation) =>
  waitForOperation(operation).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "NotFound" ||
        (error._tag === "GCP.OperationFailed" && error.code === 5),
      () => Effect.succeed(operation),
    ),
  );
