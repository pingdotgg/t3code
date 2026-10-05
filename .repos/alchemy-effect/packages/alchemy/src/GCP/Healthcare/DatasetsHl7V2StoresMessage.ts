import * as healthcare from "@distilled.cloud/gcp/healthcare_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  decodeHl7,
  encodeHl7,
  hasAlchemyLabelMap,
  lastSegment,
  listRegionDatasets,
  listHl7V2Stores,
  listMessages,
  parentOf,
  retryTransient,
  sameText,
} from "./internal.ts";

export type PatientId = {
  /** Patient identifier value (PID-2/3/4). */
  value?: string;
  /** Identifier type, for example `MRN`. */
  type?: string;
};

export type DatasetsHl7V2StoresMessageProps = {
  /**
   * Parent HL7v2 store resource name
   * `projects/{project}/locations/{location}/datasets/{dataset}/hl7V2Stores/{store}`.
   * Immutable — changing it replaces the message.
   */
  parent: string;
  /**
   * Raw HL7v2 message text. Segment terminator is CR. Alchemy
   * base64-encodes this for the Healthcare API. Immutable — changing it
   * replaces the message.
   */
  data: string;
  /**
   * Server-assigned message id. Set on create. Immutable — changing it
   * replaces the message.
   */
  messageId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type DatasetsHl7V2StoresMessage = Resource<
  "GCP.Healthcare.DatasetsHl7V2StoresMessage",
  DatasetsHl7V2StoresMessageProps,
  {
    /**
     * Full resource name
     * `projects/{project}/locations/{location}/datasets/{dataset}/hl7V2Stores/{store}/messages/{message}`.
     */
    name: string;
    /** Server-assigned message id. */
    messageId: string;
    /** Parent HL7v2 store resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Raw HL7v2 message text (decoded from the API bytes). */
    data: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Message type from MSH-9.1. */
    messageType: string | undefined;
    /** Sending facility from MSH-4. */
    sendFacility: string | undefined;
    /** Datetime the sending application sent this message (MSH-7). */
    sendTime: string | undefined;
    /** Patient ids parsed from PID-2, PID-3, and PID-4. */
    patientIds: PatientId[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An HL7v2 message stored in a Cloud Healthcare HL7v2 store.
 *
 * Message ids are server-assigned. Parent store and raw `data` are
 * identity — changing either replaces the message. Labels update in
 * place (`updateMask=labels`).
 *
 * ### Creating a Message
 * **Example:** ADT^A01 into an existing store
 * ```typescript
 * const message = yield* GCP.Healthcare.DatasetsHl7V2StoresMessage("Adt", {
 *   parent: store.name,
 *   data: [
 *     "MSH|^~\\&|APP|FACILITY|DEST|DESTFAC|20240101120000||ADT^A01|MSG00001|P|2.5",
 *     "PID|1||PAT001^^^MR||DOE^JOHN",
 *   ].join("\r"),
 *   labels: { env: "test" },
 * });
 * ```
 *
 * ### Updating a Message
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Relabel an existing message
 * ```typescript
 * const message = yield* GCP.Healthcare.DatasetsHl7V2StoresMessage("Adt", {
 *   parent: store.name,
 *   data: [
 *     "MSH|^~\\&|APP|FACILITY|DEST|DESTFAC|20240101120000||ADT^A01|MSG00001|P|2.5",
 *     "PID|1||PAT001^^^MR||DOE^JOHN",
 *   ].join("\r"),
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsHl7V2StoresMessage = Resource<DatasetsHl7V2StoresMessage>(
  "GCP.Healthcare.DatasetsHl7V2StoresMessage",
);

export class DatasetsHl7V2StoresMessageNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsHl7V2StoresMessageNotResolved",
)<{
  parent: string;
  messageId: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const resourceNameOf = (parent: string, messageId: string) =>
  `${parent}/messages/${messageId}`;

const locationOf = (name: string, fallback: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("locations");
  return index >= 0 ? (parts[index + 1] ?? fallback) : fallback;
};

const projectOf = (name: string, fallback: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("projects");
  return index >= 0 ? (parts[index + 1] ?? fallback) : fallback;
};

const toAttrs = (
  message: healthcare.Message,
  project: string,
  data: string,
  region: string,
) => {
  const name = message.name ?? "";
  return {
    name,
    messageId: lastSegment(name),
    parent: parentOf(name),
    project: projectOf(name, project),
    location: locationOf(name, region),
    data,
    labels: userLabels(message.labels),
    messageType: message.messageType,
    sendFacility: message.sendFacility,
    sendTime: message.sendTime,
    patientIds: (message.patientIds ?? []).map((id) => ({
      value: id.value,
      type: id.type,
    })),
    createTime: message.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsHl7V2StoresMessages({
          name,
          view: "FULL",
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (parent: string, id: string) =>
  Effect.gen(function* () {
    const items = yield* listMessages(parent);
    for (const item of items) {
      if (yield* hasAlchemyLabels(id, tagRecord(item.labels))) {
        return item;
      }
    }
    return undefined;
  });

const listOwnedMessages = (project: string, region: string) =>
  Effect.gen(function* () {
    const datasets = yield* listRegionDatasets(project, region);
    const named = datasets.filter((dataset) => (dataset.name ?? "").length > 0);
    const stores = yield* Effect.forEach(
      named,
      (dataset) => listHl7V2Stores(dataset.name!),
      { concurrency: 4 },
    );
    const storeNames = stores
      .flat()
      .map((store) => store.name)
      .filter((name): name is string => (name ?? "").length > 0);
    const pages = yield* Effect.forEach(storeNames, listMessages, {
      concurrency: 4,
    });
    return pages.flat().filter((message) => hasAlchemyLabelMap(message.labels));
  });

export const DatasetsHl7V2StoresMessageProvider = () =>
  Provider.succeed(DatasetsHl7V2StoresMessage, {
    stables: [
      "name",
      "messageId",
      "parent",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.messageId ?? output?.messageId;
      if (
        previousId !== undefined &&
        news.messageId !== undefined &&
        news.messageId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousData = olds?.data ?? output?.data;
      if (previousData !== undefined && news.data !== previousData) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const messageId = olds?.messageId ?? output?.messageId;
      const name =
        output?.name ??
        (messageId !== undefined && parent.length > 0
          ? resourceNameOf(parent, messageId)
          : "");
      let existing = yield* getByName(name);
      if (existing === undefined) {
        existing = yield* findOwned(parent, id);
      }
      if (existing === undefined) return undefined;
      const data = yield* decodeHl7(existing.data);
      const attrs = toAttrs(existing, env.project, data, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const messages = yield* listOwnedMessages(env.project, env.region);
        return yield* Effect.forEach(messages, (message) =>
          Effect.gen(function* () {
            const data = yield* decodeHl7(message.data);
            return toAttrs(message, env.project, data, env.region);
          }),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = news.parent;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const encoded = yield* encodeHl7(news.data);
      const name =
        output?.name ??
        (news.messageId !== undefined
          ? resourceNameOf(parent, news.messageId)
          : "");

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findOwned(parent, id);
      }

      if (current === undefined) {
        const created = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsHl7V2StoresMessages({
            parent,
            body: {
              message: {
                data: encoded,
                labels: desiredLabels,
              },
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => findOwned(parent, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetsHl7V2StoresMessageNotResolved({
          parent,
          messageId: news.messageId ?? output?.messageId ?? "",
        });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      if (labelsChanged) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasetsHl7V2StoresMessages({
            name: currentName,
            updateMask: "labels",
            body: {
              labels: desiredLabels,
            },
          }),
        );
      }

      const data = sameText(current.data, encoded)
        ? news.data
        : yield* decodeHl7(current.data);
      return toAttrs(current, env.project, data, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasetsHl7V2StoresMessages({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
