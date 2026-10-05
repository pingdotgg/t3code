import * as healthcare from "@distilled.cloud/gcp/healthcare_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  expandParent,
  hasAlchemyLabelMap,
  listAlchemyConsentStores,
  normalizeLocation,
  parseResourceName,
  retryTransient,
  sameJson,
  sameText,
  updateMaskOf,
  userLabels,
  waitUntilGone,
  withOwnershipMetadata,
} from "./internal.ts";

export type ConsentPolicy = {
  /** Resource attributes this policy matches. */
  resourceAttributes?: healthcare.Attribute[];
  /** CEL authorization rule. */
  authorizationRule?: healthcare.Expr;
};

export type DatasetsConsentStoresConsentProps = {
  /**
   * Parent consent store. Full name
   * `.../consentStores/{consentStore}` or the store id (combined with
   * `dataset` and `location`). Immutable — changing it replaces the
   * consent.
   */
  consentStore: string;
  /**
   * Parent dataset used when `consentStore` is a bare id.
   */
  dataset?: string;
  /**
   * Region used when `consentStore` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User UUID supplied by the client.
   */
  userId: string;
  /**
   * Consent artifact resource name proving the end-user consent.
   */
  consentArtifact: string;
  /**
   * Consent state. Created as `DRAFT` unless set. State transitions
   * after create use activate/revoke RPCs (`ACTIVE`, `REVOKED`).
   * @default "DRAFT"
   */
  state?: healthcare.ConsentStateEnum | (string & {});
  /**
   * Consent metadata. Alchemy ownership keys are merged in
   * automatically.
   */
  metadata?: Record<string, string>;
  /**
   * Authorization policies.
   */
  policies?: ConsentPolicy[];
  /**
   * Input-only TTL from create time (e.g. `"86400s"`).
   */
  ttl?: string;
};

export type DatasetsConsentStoresConsent = Resource<
  "GCP.Healthcare.DatasetsConsentStoresConsent",
  DatasetsConsentStoresConsentProps,
  {
    /** Full resource name `.../consents/{consent}`. */
    name: string;
    /** Server-assigned consent id. */
    consentId: string;
    /** Parent consent store resource name. */
    consentStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User id. */
    userId: string | undefined;
    /** Consent artifact resource name. */
    consentArtifact: string | undefined;
    /** Consent state. */
    state: string | undefined;
    /** User metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Revision id. */
    revisionId: string | undefined;
    /** RFC3339 revision create time. */
    revisionCreateTime: string | undefined;
    /** RFC3339 expiry. */
    expireTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A user's consent in a consent store.
 *
 * Consent ids are server-assigned. `userId`, policies, consent artifact,
 * and metadata update by committing a new revision. Ownership is stamped
 * into `metadata`.
 *
 * ### Creating a Consent
 * **Example:** Draft consent
 * ```typescript
 * const consent = yield* GCP.Healthcare.DatasetsConsentStoresConsent(
 *   "Grant",
 *   {
 *     consentStore: store.name,
 *     userId: "user-123",
 *     consentArtifact: artifact.name,
 *     state: "DRAFT",
 *     metadata: { source: "app" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsConsentStoresConsent =
  Resource<DatasetsConsentStoresConsent>(
    "GCP.Healthcare.DatasetsConsentStoresConsent",
  );

export class DatasetsConsentStoresConsentNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsConsentStoresConsentNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_STATE = "DRAFT";

const storeOf = (
  consentStore: string,
  project: string,
  location: string,
  dataset: string | undefined,
) => {
  if (consentStore.includes("/")) return consentStore.replace(/\/+$/, "");
  if (dataset === undefined) {
    return expandParent(consentStore, project, location, "consentStores");
  }
  const datasetName = expandParent(dataset, project, location, "datasets");
  return `${datasetName}/consentStores/${consentStore}`;
};

const toAttrs = (
  consent: healthcare.Consent,
  project: string,
  region: string,
) => {
  const name = consent.name ?? "";
  const parsed = parseResourceName(name, "consents", region);
  return {
    name,
    consentId: parsed.id.split("@")[0] ?? parsed.id,
    consentStore: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    userId: consent.userId,
    consentArtifact: consent.consentArtifact,
    state: consent.state,
    metadata: userLabels(consent.metadata),
    revisionId: consent.revisionId,
    revisionCreateTime: consent.revisionCreateTime,
    expireTime: consent.expireTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsConsentStoresConsents({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetsConsentStoresConsentProvider = () =>
  Provider.succeed(DatasetsConsentStoresConsent, {
    stables: ["name", "consentId", "consentStore", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = olds?.consentStore ?? output?.consentStore;
      const nextParent = storeOf(
        news.consentStore,
        env.project,
        normalizeLocation(news.location ?? output?.location, env.region),
        news.dataset,
      );
      if (previousParent !== undefined && previousParent !== nextParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listAlchemyConsentStores(env.project, env.region);
        const consents = yield* Effect.forEach(
          stores,
          (store) =>
            collectPages(
              healthcare.listProjectsLocationsDatasetsConsentStoresConsents.pages(
                {
                  parent: store.name ?? "",
                  pageSize: 1000,
                },
              ),
              (page) => page.consents,
            ),
          { concurrency: 4 },
        );
        return consents
          .flat()
          .filter((consent) => hasAlchemyLabelMap(consent.metadata))
          .map((consent) => toAttrs(consent, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const consentStore = storeOf(
        news.consentStore,
        env.project,
        location,
        news.dataset,
      );
      const ownership = yield* createInternalLabels(id);
      const metadata = withOwnershipMetadata(news.metadata, ownership);
      const state = news.state ?? DEFAULT_STATE;

      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        current = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsConsentStoresConsents({
            parent: consentStore,
            body: {
              userId: news.userId,
              consentArtifact: news.consentArtifact,
              state,
              metadata,
              policies: news.policies,
              ttl: news.ttl,
            },
          }),
        );
      }

      if (current === undefined) {
        return yield* new DatasetsConsentStoresConsentNotResolved({
          name: consentStore,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const userChanged = !sameText(current.userId, news.userId);
      const artifactChanged = !sameText(
        current.consentArtifact,
        news.consentArtifact,
      );
      const policiesChanged = !sameJson(current.policies, news.policies);
      const metadataChanged =
        !sameJson(userLabels(current.metadata), userLabels(news.metadata)) ||
        !hasAlchemyLabelMap(current.metadata);

      if (
        userChanged ||
        artifactChanged ||
        policiesChanged ||
        metadataChanged
      ) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasetsConsentStoresConsents({
            name: currentName,
            updateMask: updateMaskOf(
              userChanged ? "userId" : undefined,
              artifactChanged ? "consentArtifact" : undefined,
              policiesChanged ? "policies" : undefined,
              metadataChanged ? "metadata" : undefined,
            ),
            body: {
              userId: news.userId,
              consentArtifact: news.consentArtifact,
              policies: news.policies,
              metadata,
            },
          }),
        );
      }

      const currentState = current.state ?? DEFAULT_STATE;
      if (state === "ACTIVE" && currentState === "DRAFT") {
        current = yield* retryTransient(
          healthcare.activateProjectsLocationsDatasetsConsentStoresConsents({
            name: current.name ?? currentName,
            body: {
              consentArtifact: news.consentArtifact,
            },
          }),
        );
      } else if (state === "REVOKED" && currentState === "ACTIVE") {
        current = yield* retryTransient(
          healthcare.revokeProjectsLocationsDatasetsConsentStoresConsents({
            name: current.name ?? currentName,
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasetsConsentStoresConsents({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
