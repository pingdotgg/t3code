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
  userLabels,
  waitUntilGone,
  withOwnershipMetadata,
} from "./internal.ts";

export type ConsentSignature = {
  /** Signing user id. */
  userId?: string;
  /** RFC3339 signature time. */
  signatureTime?: string;
  /** Signature metadata. */
  metadata?: Record<string, string>;
};

export type DatasetsConsentStoresConsentArtifactProps = {
  /**
   * Parent consent store. Full name
   * `.../consentStores/{consentStore}` or the store id (combined with
   * `dataset` and `location`). Immutable — changing it replaces the
   * artifact.
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
   * Version string of the consent information shown to the user.
   */
  consentContentVersion?: string;
  /**
   * Artifact metadata. Alchemy ownership keys are merged in
   * automatically (`alchemy-stack`, `alchemy-stage`, `alchemy-id`).
   */
  metadata?: Record<string, string>;
  /**
   * User signature.
   */
  userSignature?: ConsentSignature;
  /**
   * Guardian signature.
   */
  guardianSignature?: ConsentSignature;
  /**
   * Witness signature.
   */
  witnessSignature?: ConsentSignature;
};

export type DatasetsConsentStoresConsentArtifact = Resource<
  "GCP.Healthcare.DatasetsConsentStoresConsentArtifact",
  DatasetsConsentStoresConsentArtifactProps,
  {
    /** Full resource name `.../consentArtifacts/{consentArtifact}`. */
    name: string;
    /** Server-assigned artifact id. */
    consentArtifactId: string;
    /** Parent consent store resource name. */
    consentStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User id. */
    userId: string | undefined;
    /** Consent content version. */
    consentContentVersion: string | undefined;
    /** User metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * Documentation of a user's consent (artifact) in a consent store.
 *
 * Artifact ids are server-assigned. There is no patch API — changing
 * `userId`, version, metadata, or parent replaces the artifact.
 * Ownership is stamped into `metadata`.
 *
 * ### Creating a Consent Artifact
 * **Example:** Artifact for a user
 * ```typescript
 * const artifact = yield* GCP.Healthcare.DatasetsConsentStoresConsentArtifact(
 *   "Proof",
 *   {
 *     consentStore: store.name,
 *     userId: "user-123",
 *     consentContentVersion: "v1",
 *     metadata: { locale: "en" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsConsentStoresConsentArtifact =
  Resource<DatasetsConsentStoresConsentArtifact>(
    "GCP.Healthcare.DatasetsConsentStoresConsentArtifact",
  );

export class DatasetsConsentStoresConsentArtifactNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsConsentStoresConsentArtifactNotResolved",
)<{
  name: string;
}> {}

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
  artifact: healthcare.ConsentArtifact,
  project: string,
  region: string,
) => {
  const name = artifact.name ?? "";
  const parsed = parseResourceName(name, "consentArtifacts", region);
  return {
    name,
    consentArtifactId: parsed.id,
    consentStore: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    userId: artifact.userId,
    consentContentVersion: artifact.consentContentVersion,
    metadata: userLabels(artifact.metadata),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsConsentStoresConsentArtifacts({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetsConsentStoresConsentArtifactProvider = () =>
  Provider.succeed(DatasetsConsentStoresConsentArtifact, {
    stables: [
      "name",
      "consentArtifactId",
      "consentStore",
      "project",
      "location",
    ],

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
      const parentChanged =
        previousParent !== undefined && previousParent !== nextParent;
      const userChanged =
        olds?.userId !== undefined && olds.userId !== news.userId;
      const versionChanged =
        (olds?.consentContentVersion ?? output?.consentContentVersion) !==
          undefined &&
        (olds?.consentContentVersion ?? output?.consentContentVersion) !==
          news.consentContentVersion;
      if (parentChanged || userChanged || versionChanged) {
        return {
          action: "replace" as const,
          deleteFirst: !parentChanged,
        };
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
        const artifacts = yield* Effect.forEach(
          stores,
          (store) =>
            collectPages(
              healthcare.listProjectsLocationsDatasetsConsentStoresConsentArtifacts.pages(
                {
                  parent: store.name ?? "",
                  pageSize: 1000,
                },
              ),
              (page) => page.consentArtifacts,
            ),
          { concurrency: 4 },
        );
        return artifacts
          .flat()
          .filter((artifact) => hasAlchemyLabelMap(artifact.metadata))
          .map((artifact) => toAttrs(artifact, env.project, env.region));
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

      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        current = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsConsentStoresConsentArtifacts(
            {
              parent: consentStore,
              body: {
                userId: news.userId,
                consentContentVersion: news.consentContentVersion,
                metadata,
                userSignature: news.userSignature,
                guardianSignature: news.guardianSignature,
                witnessSignature: news.witnessSignature,
              },
            },
          ),
        );
      }

      if (current === undefined) {
        return yield* new DatasetsConsentStoresConsentArtifactNotResolved({
          name: consentStore,
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasetsConsentStoresConsentArtifacts(
          {
            name: output.name,
          },
        ),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
