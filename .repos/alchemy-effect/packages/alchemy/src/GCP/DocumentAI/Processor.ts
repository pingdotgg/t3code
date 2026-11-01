import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  DEFAULT_PROCESSOR_TYPE,
  MAX_PROCESSOR_DISPLAY_NAME_LENGTH,
  ProcessorFailed,
  ProcessorPending,
  ResourceNotResolved,
  encodeOwnershipLine,
  findOwnedByDisplayName,
  hasOwnershipMarker,
  listProcessorsAt,
  listProjectProcessors,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameText,
  toPhysicalId,
  waitUntilGone,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type ProcessorProps = {
  /**
   * Processor id (the `{processor}` segment of
   * `projects/{project}/locations/{location}/processors/{processor}`).
   * Assigned by the API on create. Immutable — changing it replaces the
   * processor. Supply it to adopt an existing processor.
   */
  processorId?: string;
  /**
   * Multi-region location (`us` or `eu`). Some processor types are also
   * available in regional locations. Immutable — changing it replaces the
   * processor.
   * @default "us"
   */
  location?: string;
  /**
   * Processor type such as `OCR_PROCESSOR` or `FORM_PARSER_PROCESSOR`.
   * Immutable — changing it replaces the processor.
   * @default "OCR_PROCESSOR"
   */
  type?: string;
  /**
   * User-facing display name. Processors have no labels field, so Alchemy
   * stamps ownership into this field for list / nuke. There is no update
   * API for display name — changing it replaces the processor.
   */
  displayName?: string;
  /**
   * Cloud KMS key used for CMEK. Immutable — changing it replaces the
   * processor.
   */
  kmsKeyName?: string;
  /**
   * Default processor version resource name. Updates in place via
   * `setDefaultProcessorVersion`.
   */
  defaultProcessorVersion?: string;
  /**
   * Schema version resource name used by the processor. Immutable —
   * changing it replaces the processor.
   */
  activeSchemaVersion?: string;
  /**
   * Whether the processor is enabled. Created processors start enabled.
   * Updates in place via enable / disable.
   * @default true
   */
  enabled?: boolean;
};

export type Processor = Resource<
  "GCP.DocumentAI.Processor",
  ProcessorProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/processors/{processor}`. */
    name: string;
    /** Processor id (last path segment). */
    processorId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Processor type. */
    type: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Processor state (`ENABLED`, `DISABLED`, …). */
    state: string | undefined;
    /** Default processor version resource name. */
    defaultProcessorVersion: string | undefined;
    /** HTTP endpoint that invokes processing. */
    processEndpoint: string | undefined;
    /** Cloud KMS key used for CMEK, if any. */
    kmsKeyName: string | undefined;
    /** Schema version resource name used by the processor. */
    activeSchemaVersion: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Document AI processor that extracts structure from documents.
 *
 * Processors are location-scoped. The API assigns the processor id. Type,
 * location, KMS key, and display name are immutable (there is no processor
 * patch RPC). Enable / disable and the default processor version update in
 * place. Processors have no labels, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke.
 *
 * ### Creating a Processor
 * **Example:** OCR processor
 * ```typescript
 * const processor = yield* GCP.DocumentAI.Processor("Ocr", {
 *   type: "OCR_PROCESSOR",
 *   displayName: "ocr",
 * });
 * ```
 *
 * **Example:** Explicit location
 * ```typescript
 * const processor = yield* GCP.DocumentAI.Processor("Ocr", {
 *   location: "us",
 *   type: "OCR_PROCESSOR",
 * });
 * ```
 *
 * ### Updating a Processor
 * **Example:** Disable
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const processor = yield* GCP.DocumentAI.Processor("Ocr", {
 *   location: "us",
 *   type: "OCR_PROCESSOR",
 *   enabled: false,
 * });
 * ```
 *
 * @resource
 * @category DocumentAI
 */
export const Processor = Resource<Processor>("GCP.DocumentAI.Processor");

const resourceName = (project: string, location: string, processorId: string) =>
  `${locationParent(project, location)}/processors/${processorId}`;

const typeOf = (value: string | undefined) => value ?? DEFAULT_PROCESSOR_TYPE;

const toAttrs = (
  processor: documentai.GoogleCloudDocumentaiV1Processor,
  project: string,
) => {
  const name = processor.name ?? "";
  const parsed = parseResourceName(name, "processors");
  const ownership = parseOwnership(processor.displayName);
  return {
    name,
    processorId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    type: processor.type,
    displayName: ownership.text,
    state: processor.state,
    defaultProcessorVersion: processor.defaultProcessorVersion,
    processEndpoint: processor.processEndpoint,
    kmsKeyName: processor.kmsKeyName,
    activeSchemaVersion: processor.activeSchemaVersion,
    createTime: processor.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : documentai
        .getProjectsLocationsProcessors({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  id: string,
  project: string,
  parent: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const local = yield* findOwnedByDisplayName(
      id,
      yield* listProcessorsAt(parent),
    );
    if (local !== undefined) return local;
    return yield* findOwnedByDisplayName(
      id,
      yield* listProjectProcessors(project),
    );
  });

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (processor): processor is documentai.GoogleCloudDocumentaiV1Processor =>
        processor !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (processor) => processor.state !== "FAILED",
      (processor) =>
        new ProcessorFailed({
          name,
          state: processor.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.filterOrFail(
      (processor) =>
        processor.state === "ENABLED" || processor.state === "DISABLED",
      (processor) =>
        new ProcessorPending({
          name,
          state: processor.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error instanceof ProcessorPending ||
        error instanceof ResourceNotResolved,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilState = (name: string, desired: "ENABLED" | "DISABLED") =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (processor): processor is documentai.GoogleCloudDocumentaiV1Processor =>
        processor !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (processor) => processor.state !== "FAILED",
      (processor) =>
        new ProcessorFailed({
          name,
          state: processor.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.filterOrFail(
      (processor) => processor.state === desired,
      (processor) =>
        new ProcessorPending({
          name,
          state: processor.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error instanceof ProcessorPending ||
        error instanceof ResourceNotResolved,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const ProcessorProvider = () =>
  Provider.succeed(Processor, {
    stables: [
      "name",
      "processorId",
      "project",
      "location",
      "type",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousType = olds?.type ?? output?.type;
      const nextType = typeOf(news.type);
      const previousKms = olds?.kmsKeyName ?? output?.kmsKeyName;
      const previousSchema =
        olds?.activeSchemaVersion ?? output?.activeSchemaVersion;
      const previousDisplay = olds?.displayName ?? output?.displayName;
      const extra =
        (previousType !== undefined && previousType !== nextType) ||
        (previousKms ?? "") !== (news.kmsKeyName ?? "") ||
        (previousSchema ?? "") !== (news.activeSchemaVersion ?? "") ||
        (news.displayName !== undefined &&
          previousDisplay !== undefined &&
          news.displayName !== previousDisplay);
      return replaceOnIdentity({
        previousId: olds?.processorId ?? output?.processorId,
        nextId: news.processorId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const processorId = olds?.processorId ?? output?.processorId;
      const name =
        output?.name ??
        (processorId ? resourceName(env.project, location, processorId) : "");
      const parent = locationParent(env.project, location);
      const existing = yield* findOwned(id, env.project, parent, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const processors = yield* listProjectProcessors(env.project);
        return processors
          .filter((processor) => hasOwnershipMarker(processor.displayName))
          .map((processor) => toAttrs(processor, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const fallbackName = yield* toPhysicalId(
        id,
        undefined,
        output?.displayName,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? output?.displayName ?? fallbackName,
        MAX_PROCESSOR_DISPLAY_NAME_LENGTH,
      );
      const type = typeOf(news.type);
      const hinted =
        output?.name ??
        (news.processorId
          ? resourceName(env.project, location, news.processorId)
          : "");

      let current = yield* findOwned(id, env.project, parent, hinted);

      if (current === undefined) {
        current = yield* retryTransient(
          documentai.createProjectsLocationsProcessors({
            parent,
            body: {
              type,
              displayName,
              kmsKeyName: news.kmsKeyName,
              defaultProcessorVersion: news.defaultProcessorVersion,
              activeSchemaVersion: news.activeSchemaVersion,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", (error) =>
            findOwned(id, env.project, parent, hinted).pipe(
              Effect.flatMap((found) =>
                found !== undefined
                  ? Effect.succeed(found)
                  : Effect.fail(error),
              ),
            ),
          ),
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: hinted || `${parent}/processors`,
        });
      }

      let live = current;
      const currentName = live.name ?? hinted;
      if (live.state !== "ENABLED" && live.state !== "DISABLED") {
        live = yield* waitUntilReady(currentName);
      }

      const wantEnabled = news.enabled !== false;
      if (wantEnabled && live.state === "DISABLED") {
        const operation = yield* retryTransient(
          documentai.enableProjectsLocationsProcessors({
            name: currentName,
            body: {},
          }),
        );
        yield* waitForOperation(operation);
        live = yield* waitUntilState(currentName, "ENABLED");
      } else if (!wantEnabled && live.state === "ENABLED") {
        const operation = yield* retryTransient(
          documentai.disableProjectsLocationsProcessors({
            name: currentName,
            body: {},
          }),
        );
        yield* waitForOperation(operation);
        live = yield* waitUntilState(currentName, "DISABLED");
      }

      if (
        news.defaultProcessorVersion !== undefined &&
        !sameText(live.defaultProcessorVersion, news.defaultProcessorVersion)
      ) {
        const operation = yield* retryTransient(
          documentai.setDefaultProcessorVersionProjectsLocationsProcessors({
            processor: currentName,
            body: {
              defaultProcessorVersion: news.defaultProcessorVersion,
            },
          }),
        );
        yield* waitForOperation(operation);
        live = (yield* getByName(currentName)) ?? live;
      }

      return toAttrs(live, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* retryTransient(
        documentai.deleteProjectsLocationsProcessors({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
