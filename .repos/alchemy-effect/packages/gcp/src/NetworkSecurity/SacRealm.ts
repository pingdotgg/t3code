import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, diffLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "sacRealms";
const DEFAULT_SECURITY_SERVICE =
  "PALO_ALTO_PRISMA_ACCESS" satisfies networksecurity.SACRealmSecurityServiceEnum;

export type SacRealmSecurityService = networksecurity.SACRealmSecurityServiceEnum | (string & {});

export type SacRealmPairingKey = {
  /** Pairing key value shared with the SSE partner. */
  key: string | undefined;
  /** RFC3339 expiry of the pairing key. */
  expireTime: string | undefined;
};

export type SacRealmProps = {
  /**
   * Realm id (the `{sacRealm}` segment of
   * `projects/{project}/locations/global/sacRealms/{sacRealm}`). If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the realm.
   */
  sacRealmId?: string;
  /**
   * Location of the realm. Realms are global — always `"global"`.
   * Immutable — changing it replaces the realm. `GLOBAL` is accepted
   * and normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * SSE service provider associated with the realm. Immutable —
   * changing it replaces the realm.
   * @default "PALO_ALTO_PRISMA_ACCESS"
   */
  securityService?: SacRealmSecurityService;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * The SAC realm API has no patch, so changing labels replaces the
   * realm.
   */
  labels?: Record<string, string>;
};

export type SacRealm = Resource<
  "GCP.NetworkSecurity.SacRealm",
  SacRealmProps,
  {
    /** Full resource name. */
    name: string;
    /** Realm id (last path segment). */
    sacRealmId: string;
    /** Project id. */
    project: string;
    /** Location id. Always `"global"`. */
    location: string;
    /** SSE service provider. */
    securityService: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state. */
    state: string | undefined;
    /** Pairing key used during partner handshake. */
    pairingKey: SacRealmPairingKey | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Secure Access Connect (SAC) realm — the handshake between a Google
 * Cloud project and an SSE partner such as Palo Alto Prisma Access.
 *
 * The create API has no patch; changing `sacRealmId`, `location`,
 * `securityService`, or labels replaces the realm.
 *
 * ### Creating a Realm
 * **Example:** Generated name
 * ```typescript
 * const realm = yield* GCP.NetworkSecurity.SacRealm("Prisma", {});
 * ```
 *
 * **Example:** Named realm with labels
 * ```typescript
 * const realm = yield* GCP.NetworkSecurity.SacRealm("Prisma", {
 *   sacRealmId: "app-prisma",
 *   securityService: "PALO_ALTO_PRISMA_ACCESS",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const SacRealm = Resource<SacRealm>("GCP.NetworkSecurity.SacRealm");

export class SacRealmNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.SacRealmNotResolved",
)<{
  resourceName: string;
}> {}

export class SacRealmFailed extends Data.TaggedError("GCP.NetworkSecurity.SacRealmFailed")<{
  resourceName: string;
  state: string | undefined;
}> {}

export class SacRealmStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.SacRealmStillExists",
)<{
  resourceName: string;
}> {}

const isPendingState = (state: string | undefined) => state === "STATE_UNSPECIFIED";

const toPairingKey = (
  key: networksecurity.SACRealmPairingKey | undefined,
): SacRealmPairingKey | undefined =>
  key === undefined
    ? undefined
    : {
        key: key.key,
        expireTime: key.expireTime,
      };

const toAttrs = (realm: networksecurity.SACRealm, project: string) => {
  const name = realm.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    sacRealmId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    securityService: realm.securityService,
    labels: userLabels(realm.labels),
    state: realm.state,
    pairingKey: toPairingKey(realm.pairingKey),
    createTime: realm.createTime,
    updateTime: realm.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsSacRealms({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (realm): realm is networksecurity.SACRealm => realm !== undefined,
      () => new SacRealmNotResolved({ resourceName: name }),
    ),
    Effect.filterOrFail(
      (realm) => realm.state !== "KEY_EXPIRED",
      (realm) => new SacRealmFailed({ resourceName: name, state: realm.state }),
    ),
    Effect.filterOrFail(
      (realm) => !isPendingState(realm.state),
      () => new SacRealmNotResolved({ resourceName: name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.NetworkSecurity.SacRealmNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((realm) =>
      realm === undefined
        ? Effect.void
        : Effect.fail(new SacRealmStillExists({ resourceName: name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.NetworkSecurity.SacRealmStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsSacRealms
    .pages({
      parent: parentOf(project, DEFAULT_LOCATION),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sacRealms ?? [])),
      Stream.filter((realm) =>
        Object.keys(realm.labels ?? {}).some((key) => key.startsWith("alchemy-")),
      ),
      Stream.map((realm) => toAttrs(realm, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const SacRealmProvider = () =>
  Provider.succeed(SacRealm, {
    stables: ["name", "sacRealmId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.sacRealmId ?? output?.sacRealmId;
      const nextId = news.sacRealmId ?? previousId;
      const previousLocation = normalizeLocation(olds?.location ?? output?.location);
      const nextLocation = normalizeLocation(news.location ?? olds?.location ?? output?.location);
      const previousService = (
        olds?.securityService ??
        output?.securityService ??
        DEFAULT_SECURITY_SERVICE
      ).toUpperCase();
      const nextService = (news.securityService ?? previousService).toUpperCase();
      const previousLabels = {
        ...toLabels(olds?.labels),
      };
      const nextLabels = {
        ...toLabels(news.labels),
      };
      const { upsert, removed } = diffLabels(previousLabels, nextLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const replace =
        (previousId !== undefined && nextId !== undefined && nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousService !== nextService ||
        labelsChanged;
      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sacRealmId = yield* toId(id, olds?.sacRealmId, output?.sacRealmId, "sacr");
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name = output?.name ?? resourceName(env.project, location, COLLECTION, sacRealmId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sacRealmId = yield* toId(id, news.sacRealmId, output?.sacRealmId, "sacr");
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, COLLECTION, sacRealmId);
      const securityService = news.securityService ?? DEFAULT_SECURITY_SERVICE;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsSacRealms({
            parent: parentOf(env.project, location),
            sacRealmId,
            body: {
              securityService,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.undefined),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new SacRealmNotResolved({ resourceName: name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsSacRealms({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
