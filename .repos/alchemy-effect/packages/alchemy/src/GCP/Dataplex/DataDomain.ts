import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DataplexNotResolved,
  collectPages,
  fingerprint,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DataDomainContact = dataplex.GoogleCloudDataplexV1ContactIdentity;
export type DataDomainContacts = dataplex.GoogleCloudDataplexV1Contacts;

export type DataDomainProps = {
  /**
   * DataDomain id. If omitted, a unique name is generated. Must contain
   * only lowercase letters, numbers and hyphens, start with a letter,
   * end with a letter or number, and be 1-63 characters. Immutable —
   * changing it replaces the domain.
   */
  dataDomainId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * domain.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name. Required.
   */
  displayName: string;
  /**
   * User-provided description.
   */
  description?: string;
  /**
   * Immutable parent DataDomain resource name. Empty for a top-level
   * domain. Changing it replaces the domain.
   */
  parentDataDomain?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Business contacts for the domain. Required.
   */
  contacts: DataDomainContacts;
};

export type DataDomain = Resource<
  "GCP.Dataplex.DataDomain",
  DataDomainProps,
  {
    /** Full resource name. */
    name: string;
    /** DataDomain id (last path segment). */
    dataDomainId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Parent DataDomain resource name, if nested. */
    parentDataDomain: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Business contacts. */
    contacts: DataDomainContacts | undefined;
    /** System uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex DataDomain — a logical grouping of data resources for
 * governance, discovery, and management.
 *
 * Location, domain id, and parent domain are immutable. Display name,
 * description, contacts, and labels update in place.
 *
 * ### Creating a DataDomain
 * **Example:** Top-level domain
 * ```typescript
 * const domain = yield* GCP.Dataplex.DataDomain("Finance", {
 *   displayName: "Finance",
 *   labels: { env: "test" },
 *   contacts: {
 *     identities: [
 *       {
 *         contactName: "steward",
 *         contactRole: "steward",
 *         contactId: "steward@example.com",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const DataDomain = Resource<DataDomain>("GCP.Dataplex.DataDomain");

const resourceName = (
  project: string,
  location: string,
  dataDomainId: string,
) => `projects/${project}/locations/${location}/dataDomains/${dataDomainId}`;

const toAttrs = (
  domain: dataplex.GoogleCloudDataplexV1DataDomain,
  project: string,
) => {
  const name = domain.name ?? "";
  const parsed = parseName(name, "dataDomains");
  return {
    name,
    dataDomainId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: domain.displayName,
    description: domain.description,
    parentDataDomain: domain.parentDataDomain,
    labels: userLabels(domain.labels),
    contacts: domain.contacts,
    uid: domain.uid,
    createTime: domain.createTime,
    updateTime: domain.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsDataDomains({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listDomains = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      dataplex.listProjectsLocationsDataDomains.pages({
        parent,
        pageSize: 100,
      }),
      (page) => page.dataDomains,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );
  return listAtLocation(project, region, collect);
};

export const listAlchemyDataDomains = (project: string, region: string) =>
  listDomains(project, region);

export const DataDomainProvider = () =>
  Provider.succeed(DataDomain, {
    stables: [
      "name",
      "dataDomainId",
      "project",
      "location",
      "parentDataDomain",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.dataDomainId ?? output?.dataDomainId,
        nextId: news.dataDomainId ?? olds?.dataDomainId ?? output?.dataDomainId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.parentDataDomain ?? output?.parentDataDomain,
        nextParent: news.parentDataDomain ?? olds?.parentDataDomain,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataDomainId = yield* toPhysicalId(
        id,
        olds?.dataDomainId,
        output?.dataDomainId,
        "datadomain",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, dataDomainId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listDomains(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dataDomainId = yield* toPhysicalId(
        id,
        news.dataDomainId,
        output?.dataDomainId,
        "datadomain",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, dataDomainId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryQuota(
          dataplex.createProjectsLocationsDataDomains({
            parent: parentOf(env.project, location),
            dataDomainId,
            body: {
              displayName: news.displayName,
              description: news.description,
              parentDataDomain: news.parentDataDomain,
              labels: desiredLabels,
              contacts: news.contacts,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new DataplexNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayNameChanged =
        (current.displayName ?? "") !== news.displayName;
      const contactsChanged =
        fingerprint(current.contacts) !== fingerprint(news.contacts);

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        contactsChanged
      ) {
        const operation = yield* dataplex.patchProjectsLocationsDataDomains({
          name: current.name ?? name,
          updateMask: [
            labelsChanged ? "labels" : undefined,
            descriptionChanged ? "description" : undefined,
            displayNameChanged ? "displayName" : undefined,
            contactsChanged ? "contacts" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name: current.name ?? name,
            displayName: news.displayName,
            description: news.description,
            labels: desiredLabels,
            contacts: news.contacts,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dataplex
        .deleteProjectsLocationsDataDomains({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
