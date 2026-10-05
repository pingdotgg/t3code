import * as analyticshub from "@distilled.cloud/gcp/analyticshub_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AnalyticshubNotResolved,
  displayNameOf,
  encodeDescription,
  expandParent,
  deleteRetry,
  hasOwnershipMarker,
  listChildResources,
  listExchangesInProject,
  listQueryTemplates,
  namedOf,
  normalizeLocation,
  ownedById,
  ownershipLabels,
  parseDescription,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

export type QueryTemplateRoutine = analyticshub.Routine;
export type QueryTemplateState =
  | analyticshub.QueryTemplateStateEnum
  | (string & {});

export type DataExchangesQueryTemplateProps = {
  /**
   * Parent data exchange. Full name
   * `projects/{project}/locations/{location}/dataExchanges/{dataExchange}`
   * or the exchange id (combined with `location`). Query templates live
   * in data clean room exchanges. Immutable — changing the parent
   * replaces the template.
   */
  dataExchange: string;
  /**
   * Query template id (the `{queryTemplate}` segment of
   * `.../dataExchanges/{dataExchange}/queryTemplates/{queryTemplate}`).
   * If omitted, a unique id is generated. Letters, numbers, and
   * underscores; max 100 bytes. Immutable — changing it replaces the
   * template.
   */
  queryTemplateId?: string;
  /**
   * Location used when `dataExchange` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable display name. Max 63 bytes. Defaults to the template
   * id. Immutable — changing it replaces the template.
   */
  displayName?: string;
  /**
   * Short description (max 2000 bytes). Query templates have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
  /**
   * Documentation describing the query template.
   */
  documentation?: string;
  /**
   * Email or URL of the primary point of contact. Max 1000 bytes.
   */
  primaryContact?: string;
  /**
   * Email or URL of the proposer. Max 1000 bytes. Will be deprecated in
   * favor of `primaryContact`.
   */
  proposer?: string;
  /**
   * Table-valued function associated with the template.
   */
  routine?: QueryTemplateRoutine;
};

export type DataExchangesQueryTemplate = Resource<
  "GCP.AnalyticsHub.DataExchangesQueryTemplate",
  DataExchangesQueryTemplateProps,
  {
    /** Full resource name. */
    name: string;
    /** Query template id (last path segment). */
    queryTemplateId: string;
    /** Parent data exchange resource name. */
    dataExchange: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Documentation. */
    documentation: string | undefined;
    /** Primary contact. */
    primaryContact: string | undefined;
    /** Proposer contact. */
    proposer: string | undefined;
    /** Associated routine. */
    routine: QueryTemplateRoutine | undefined;
    /** Lifecycle state (`DRAFTED`, `PENDING`, `APPROVED`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Analytics Hub query template — a shared table-valued function
 * defined by contributors in a data clean room.
 *
 * Parent exchange, location, template id, and display name are
 * immutable. Description, documentation, contacts, and the routine
 * body update in place. Create the parent exchange with
 * `sharingEnvironmentConfig: { dcrExchangeConfig: {} }`.
 *
 * Query templates have no labels. Alchemy stamps ownership into the
 * description so `list` / `pnpm nuke:gcp` can find them.
 *
 * ### Creating a Query Template
 * **Example:** Draft TVF in a data clean room
 * ```typescript
 * const dcr = yield* GCP.AnalyticsHub.DataExchange("CleanRoom", {
 *   displayName: "Clean Room",
 *   sharingEnvironmentConfig: { dcrExchangeConfig: {} },
 * });
 * const template = yield* GCP.AnalyticsHub.DataExchangesQueryTemplate(
 *   "Counts",
 *   {
 *     dataExchange: dcr.name,
 *     displayName: "Counts",
 *     routine: {
 *       routineType: "TABLE_VALUED_FUNCTION",
 *       definitionBody: "SELECT 1 AS n",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category AnalyticsHub
 */
export const DataExchangesQueryTemplate = Resource<DataExchangesQueryTemplate>(
  "GCP.AnalyticsHub.DataExchangesQueryTemplate",
);

const parentExchange = (
  dataExchange: string,
  project: string,
  location: string,
) => expandParent(dataExchange, project, location, "dataExchanges");

const resourceName = (dataExchange: string, queryTemplateId: string) =>
  `${dataExchange}/queryTemplates/${queryTemplateId}`;

const desiredRoutine = (
  queryTemplateId: string,
  routine: QueryTemplateRoutine | undefined,
): QueryTemplateRoutine | undefined => {
  if (routine === undefined) return undefined;
  const body = routine.definitionBody ?? "";
  const definitionBody =
    body.startsWith(`${queryTemplateId}(`) ||
    body.startsWith(`${queryTemplateId} `)
      ? body
      : `${queryTemplateId}() AS (${body})`;
  return { ...routine, definitionBody };
};

const toAttrs = (template: analyticshub.QueryTemplate, project: string) => {
  const name = template.name ?? "";
  const parsed = parseResourceName(name, "queryTemplates");
  const { description } = parseDescription(template.description);
  return {
    name,
    queryTemplateId: parsed.id,
    dataExchange: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: template.displayName,
    description,
    documentation: template.documentation,
    primaryContact: template.primaryContact,
    proposer: template.proposer,
    routine: template.routine,
    state: template.state,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const getByName = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0) return undefined;
    const parsed = parseResourceName(name, "queryTemplates");
    const items = yield* listQueryTemplates(parsed.parent);
    return items.find((item) => (item.name ?? "") === name);
  });

export const DataExchangesQueryTemplateProvider = () =>
  Provider.succeed(DataExchangesQueryTemplate, {
    stables: [
      "name",
      "queryTemplateId",
      "dataExchange",
      "project",
      "location",
      "createTime",
      "displayName",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousDisplay = olds?.displayName ?? output?.displayName;
      const nextDisplay = news.displayName;
      const previousDocs = olds?.documentation ?? output?.documentation;
      const nextDocs = news.documentation;
      return replaceOnIdentity({
        previousId: olds?.queryTemplateId ?? output?.queryTemplateId,
        nextId: news.queryTemplateId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        previousParent: olds?.dataExchange ?? output?.dataExchange,
        nextParent: parentExchange(news.dataExchange, env.project, location),
        extra:
          (previousDisplay !== undefined &&
            nextDisplay !== undefined &&
            previousDisplay !== nextDisplay) ||
          (previousDocs !== undefined &&
            nextDocs !== undefined &&
            previousDocs !== nextDocs),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const queryTemplateId = yield* toPhysicalId(
        id,
        olds?.queryTemplateId,
        output?.queryTemplateId,
      );
      const dataExchange =
        olds?.dataExchange !== undefined
          ? parentExchange(olds.dataExchange, env.project, location)
          : (output?.dataExchange ?? "");
      const name =
        output?.name ??
        (dataExchange ? resourceName(dataExchange, queryTemplateId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedById(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const exchanges = yield* listExchangesInProject(
          env.project,
          env.region,
        );
        const templates = yield* listChildResources(
          namedOf(exchanges),
          listQueryTemplates,
        );
        return templates
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const dataExchange = parentExchange(
        news.dataExchange,
        env.project,
        location,
      );
      const queryTemplateId = yield* toPhysicalId(
        id,
        news.queryTemplateId,
        output?.queryTemplateId,
      );
      const name = output?.name ?? resourceName(dataExchange, queryTemplateId);
      const ownership = yield* ownershipLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const displayName = displayNameOf(news.displayName, queryTemplateId);
      const body: analyticshub.QueryTemplate = {
        displayName,
        description: desiredDescription,
      };
      if (news.documentation !== undefined) {
        body.documentation = news.documentation;
      }
      if (news.primaryContact !== undefined) {
        body.primaryContact = news.primaryContact;
      }
      if (news.proposer !== undefined) {
        body.proposer = news.proposer;
      }
      const routine = desiredRoutine(queryTemplateId, news.routine);
      if (routine !== undefined) {
        body.routine = routine;
      }

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          analyticshub.createProjectsLocationsDataExchangesQueryTemplates({
            parent: dataExchange,
            queryTemplateId,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AnalyticshubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const descriptionChanged = !sameText(
        current.description,
        desiredDescription,
      );
      const contactChanged =
        news.primaryContact !== undefined &&
        !sameText(current.primaryContact, news.primaryContact);
      const proposerChanged =
        news.proposer !== undefined &&
        !sameText(current.proposer, news.proposer);
      const routineChanged =
        routine !== undefined &&
        (!sameText(current.routine?.routineType, routine.routineType) ||
          !sameText(current.routine?.definitionBody, routine.definitionBody));

      if (
        descriptionChanged ||
        contactChanged ||
        proposerChanged ||
        routineChanged
      ) {
        current = yield* retryTransient(
          analyticshub.patchProjectsLocationsDataExchangesQueryTemplates({
            name: currentName,
            updateMask: updateMaskOf(
              descriptionChanged ? "description" : undefined,
              contactChanged ? "primaryContact" : undefined,
              proposerChanged ? "proposer" : undefined,
              routineChanged ? "routine" : undefined,
            ),
            body: { name: currentName, ...body },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteRetry(
        analyticshub.deleteProjectsLocationsDataExchangesQueryTemplates({
          name: output.name,
        }),
      );
    }),
  });
