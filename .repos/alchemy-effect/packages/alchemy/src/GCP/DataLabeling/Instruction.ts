import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwned,
  hasOwnershipMarker,
  ignoreGone,
  listInstructions,
  noRetryLayer,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  projectParent,
  replaceOnIdentity,
  retryDelete,
  retryTransient,
  sameJson,
  sameText,
  toDisplayName,
  waitForVisible,
  waitUntilGone,
} from "./internal.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type InstructionDataType =
  datalabeling.GoogleCloudDatalabelingV1beta1InstructionDataTypeEnum;

export type PdfInstruction = {
  /**
   * Cloud Storage URI of the PDF (`gs://...`).
   */
  gcsFileUri?: string;
};

export type CsvInstruction = {
  /**
   * Cloud Storage URI of the CSV (`gs://...`). Deprecated — the API
   * only accepts PDF instructions.
   */
  gcsFileUri?: string;
};

export type InstructionProps = {
  /**
   * Instruction id (the last segment of
   * `projects/{project}/instructions/{instruction}`). Server-assigned
   * on create. Immutable — changing it replaces the instruction.
   */
  instructionId?: string;
  /**
   * Display name. Maximum 64 characters. Required by the API; Alchemy
   * falls back to a generated name. Immutable — changing it replaces
   * the instruction.
   */
  displayName?: string;
  /**
   * Data type this instruction applies to (`IMAGE`, `VIDEO`, `TEXT`,
   * `GENERAL_DATA`). Immutable — changing it replaces the instruction.
   */
  dataType: InstructionDataType | (string & {});
  /**
   * Human-readable description. Instructions have no labels field, so
   * Alchemy stamps ownership into this field. Immutable — changing it
   * replaces the instruction.
   */
  description?: string;
  /**
   * PDF instruction stored in Cloud Storage. Currently the only
   * supported instruction format. Immutable — changing it replaces the
   * instruction.
   */
  pdfInstruction?: PdfInstruction;
  /**
   * Deprecated CSV instruction. Immutable — changing it replaces the
   * instruction.
   */
  csvInstruction?: CsvInstruction;
};

export type Instruction = Resource<
  "GCP.DataLabeling.Instruction",
  InstructionProps,
  {
    /** Full resource name `projects/{project}/instructions/{instruction}`. */
    name: string;
    /** Instruction id (last path segment). */
    instructionId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** Data type this instruction applies to. */
    dataType: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** PDF instruction, if set. */
    pdfInstruction: PdfInstruction | undefined;
    /** Deprecated CSV instruction, if set. */
    csvInstruction: CsvInstruction | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Related resources blocking changes. */
    blockingResources: string[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Labeling instruction describing how human operators should
 * label data. Create is a long-running operation. The current API only
 * accepts a PDF stored in Cloud Storage.
 *
 * Instruction ids are server-assigned. There is no labels API, so
 * Alchemy stamps ownership into `description` so `list` / nuke can find
 * them. All input fields are immutable — changing them replaces the
 * instruction.
 *
 * ### Creating an Instruction
 * **Example:** Image labeling PDF
 * ```typescript
 * const instruction = yield* GCP.DataLabeling.Instruction("HowTo", {
 *   displayName: "image-classes",
 *   dataType: "IMAGE",
 *   pdfInstruction: {
 *     gcsFileUri: "gs://my-bucket/instructions.pdf",
 *   },
 * });
 * ```
 *
 * **Example:** Text labeling PDF with a description
 * ```typescript
 * const instruction = yield* GCP.DataLabeling.Instruction("HowTo", {
 *   displayName: "entity-extraction",
 *   dataType: "TEXT",
 *   description: "highlight product names",
 *   pdfInstruction: {
 *     gcsFileUri: "gs://my-bucket/text-instructions.pdf",
 *   },
 * });
 * ```
 *
 * @resource
 * @category DataLabeling
 */
export const Instruction = Resource<Instruction>(
  "GCP.DataLabeling.Instruction",
);

export class InstructionNotResolved extends Data.TaggedError(
  "GCP.DataLabeling.InstructionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, instructionId: string) =>
  `${projectParent(project)}/instructions/${instructionId}`;

const toAttrs = (
  instruction: datalabeling.GoogleCloudDatalabelingV1beta1Instruction,
  project: string,
) => {
  const name = instruction.name ?? "";
  const parsed = parseResourceName(name, "instructions");
  return {
    name,
    instructionId: parsed.id,
    project: parsed.project || project,
    displayName: instruction.displayName,
    dataType: instruction.dataType,
    description: parseOwnership(instruction.description).text,
    pdfInstruction: instruction.pdfInstruction,
    csvInstruction: instruction.csvInstruction,
    createTime: instruction.createTime,
    updateTime: instruction.updateTime,
    blockingResources: instruction.blockingResources,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalabeling.getProjectsInstructions({ name }).pipe(
        Effect.provide(noRetryLayer),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("BadGateway", () => Effect.succeed(undefined)),
      );

const findByOwnership = (id: string, project: string) =>
  Effect.gen(function* () {
    const rows = yield* listInstructions(projectParent(project));
    return yield* findOwned(id, rows, (row) => row.description);
  });

export const InstructionProvider = () =>
  Provider.succeed(Instruction, {
    stables: ["name", "instructionId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const extra =
        (news.displayName !== undefined &&
          output?.displayName !== undefined &&
          !sameText(news.displayName, output.displayName)) ||
        (output?.dataType !== undefined &&
          !sameText(news.dataType, output.dataType)) ||
        (olds !== undefined &&
          !sameText(news.description, output?.description)) ||
        (output !== undefined &&
          !sameJson(news.pdfInstruction, output.pdfInstruction)) ||
        (output !== undefined &&
          !sameJson(news.csvInstruction, output.csvInstruction));
      return replaceOnIdentity({
        previousId: olds?.instructionId ?? output?.instructionId,
        nextId: news.instructionId,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instructionId =
        olds?.instructionId ??
        output?.instructionId ??
        (output?.name ? parseResourceName(output.name, "instructions").id : "");
      const name =
        output?.name ??
        (instructionId.length > 0
          ? resourceName(env.project, instructionId)
          : "");
      const existing =
        (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listInstructions(projectParent(env.project));
        return rows
          .filter((row) => hasOwnershipMarker(row.description))
          .map((row) => toAttrs(row, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instructionId = news.instructionId ?? output?.instructionId;
      const name =
        output?.name ??
        (instructionId !== undefined
          ? resourceName(env.project, instructionId)
          : "");
      const ownership = yield* createInternalLabels(id);
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const description = encodeOwnership(ownership, news.description);

      let current =
        (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));

      if (current === undefined) {
        const created = yield* retryTransient(
          datalabeling.createProjectsInstructions({
            parent: projectParent(env.project),
            body: {
              instruction: {
                displayName,
                description,
                dataType: news.dataType,
                pdfInstruction: news.pdfInstruction,
                csvInstruction: news.csvInstruction,
              },
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = resourceNameFromOperation(done);
          if (createdName !== undefined) {
            current = yield* waitForVisible(getByName(createdName));
          }
        }
        if (current === undefined) {
          current = yield* findByOwnership(id, env.project);
        }
      }

      if (current === undefined) {
        return yield* new InstructionNotResolved({
          name: name || projectParent(env.project),
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreGone(
        retryDelete(
          datalabeling.deleteProjectsInstructions({ name: output.name }),
        ),
      );
      yield* waitUntilGone(getByName(output.name));
    }),
  });
