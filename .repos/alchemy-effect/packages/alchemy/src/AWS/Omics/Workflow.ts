import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { fetchOmicsTags, syncOmicsTags } from "./internal.ts";

/**
 * Coerce a definition zip that survived engine plan/state serialization back
 * into a `Uint8Array`. The engine round-trips a `Uint8Array` prop as an
 * index-keyed plain object (`{"0":80,"1":75,...}`), so a provider that carries
 * binary members must rebuild the array before encoding the request.
 */
const coerceBytes = (value: unknown): Uint8Array | undefined => {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, number>)
      .map(([k, v]) => [Number(k), v] as const)
      .sort((a, b) => a[0] - b[0]);
    return Uint8Array.from(entries.map(([, v]) => v));
  }
  return undefined;
};

export interface WorkflowProps {
  /**
   * A name for the workflow. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Mutable.
   */
  name?: string;
  /**
   * A description for the workflow. Mutable.
   */
  description?: string;
  /**
   * The workflow engine. Immutable — changing it replaces the workflow.
   * @default "WDL"
   */
  engine?: "WDL" | "NEXTFLOW" | "CWL";
  /**
   * The definition of the workflow, as a zip archive of the workflow source
   * files. Provided as raw bytes. Mutually exclusive with `definitionUri`.
   * Immutable — changing it replaces the workflow.
   */
  definitionZip?: Uint8Array;
  /**
   * The S3 URI of a zip archive containing the workflow definition. Mutually
   * exclusive with `definitionZip`. Immutable — changing it replaces the
   * workflow.
   */
  definitionUri?: string;
  /**
   * The path of the main definition file for the workflow within the zip
   * archive. Immutable.
   */
  main?: string;
  /**
   * A parameter template describing the workflow's input parameters.
   * Immutable.
   */
  parameterTemplate?: Record<
    string,
    { description?: string; optional?: boolean }
  >;
  /**
   * The default static storage capacity (in gibibytes) for runs that use this
   * workflow. Mutable.
   */
  storageCapacity?: number;
  /**
   * The storage type for runs that use this workflow. Mutable.
   * @default "DYNAMIC"
   */
  storageType?: "STATIC" | "DYNAMIC";
  /**
   * The computational accelerators used by the workflow. Immutable.
   */
  accelerators?: "GPU";
  /**
   * Tags to apply to the workflow. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Workflow extends Resource<
  "AWS.Omics.Workflow",
  WorkflowProps,
  {
    /**
     * ID of the workflow.
     */
    workflowId: string;
    /**
     * ARN of the workflow.
     */
    workflowArn: string;
    /**
     * Name of the workflow.
     */
    name: string;
    /**
     * Workflow status (e.g. `ACTIVE`, `CREATING`, `UPDATING`, `FAILED`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon HealthOmics private workflow — a bioinformatics workflow (WDL,
 * Nextflow, or CWL) that is executed as one or more runs.
 *
 * A workflow name is auto-generated from the app, stage, and logical ID
 * unless you provide one. The workflow definition (`engine`, `definitionZip`,
 * `definitionUri`, `main`, `parameterTemplate`, `accelerators`) is immutable —
 * changing any of it replaces the workflow. `name`, `description`,
 * `storageCapacity`, and `storageType` are updated in place.
 * @resource
 * @section Creating a Workflow
 * @example Workflow from an inline definition zip
 * ```typescript
 * import * as Omics from "alchemy/AWS/Omics";
 *
 * const workflow = yield* Omics.Workflow("Hello", {
 *   engine: "WDL",
 *   main: "main.wdl",
 *   definitionZip: myZipBytes,
 * });
 * ```
 *
 * @example Workflow from an S3-hosted definition
 * ```typescript
 * const workflow = yield* Omics.Workflow("Hello", {
 *   engine: "NEXTFLOW",
 *   definitionUri: "s3://my-bucket/workflows/hello.zip",
 * });
 * ```
 */
export const Workflow = Resource<Workflow>("AWS.Omics.Workflow");

export const WorkflowProvider = () =>
  Provider.effect(
    Workflow,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 96 }));
      });

      // A freshly created workflow is CREATING until its definition is
      // validated; wait until it reaches a terminal state before returning so
      // downstream runs (and deletes) don't race the async provisioning.
      const waitUntilReady = Effect.fn(function* (workflowId: string) {
        const final = yield* omics.getWorkflow({ id: workflowId }).pipe(
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(11),
            ]),
            until: (w) => w.status === "ACTIVE" || w.status === "FAILED",
          }),
        );
        if (final.status === "FAILED") {
          return yield* Effect.fail(
            new omics.ValidationException({
              message: `Workflow ${workflowId} failed: ${final.statusMessage ?? "unknown"}`,
            }),
          );
        }
        return final;
      });

      return Workflow.Provider.of({
        stables: ["workflowId", "workflowArn"],
        list: () =>
          omics.listWorkflows.items({}).pipe(
            Stream.map((item) => ({
              workflowId: item.id!,
              workflowArn: item.arn!,
              name: item.name ?? "",
              status: item.status ?? "",
            })),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
        read: Effect.fn(function* ({ id, output }) {
          if (output?.workflowId === undefined) return undefined;
          const found = yield* omics
            .getWorkflow({ id: output.workflowId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (found === undefined || found.id === undefined) return undefined;
          const attrs = {
            workflowId: found.id,
            workflowArn: found.arn!,
            name: found.name ?? "",
            status: found.status ?? "",
          };
          const tags = yield* fetchOmicsTags(found.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const prev = olds ?? {};
          if (
            (prev.engine ?? "WDL") !== (news.engine ?? "WDL") ||
            (prev.definitionUri ?? "") !== (news.definitionUri ?? "") ||
            (prev.main ?? "") !== (news.main ?? "") ||
            (prev.accelerators ?? "") !== (news.accelerators ?? "")
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          let workflow =
            output?.workflowId === undefined
              ? undefined
              : yield* omics
                  .getWorkflow({ id: output.workflowId })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  );

          if (workflow === undefined || workflow.id === undefined) {
            const created = yield* omics.createWorkflow({
              name,
              description: news.description,
              engine: news.engine ?? "WDL",
              definitionZip: coerceBytes(news.definitionZip),
              definitionUri: news.definitionUri,
              main: news.main,
              parameterTemplate: news.parameterTemplate,
              storageCapacity: news.storageCapacity,
              storageType: news.storageType,
              accelerators: news.accelerators,
              requestId: `alchemy-${id}`,
              tags: desiredTags,
            });
            yield* waitUntilReady(created.id!);
            workflow = yield* omics.getWorkflow({ id: created.id! });
          } else {
            const patch: {
              name?: string;
              description?: string;
              storageType?: string;
              storageCapacity?: number;
            } = {};
            if (news.name !== undefined && news.name !== workflow.name) {
              patch.name = news.name;
            }
            if (
              news.description !== undefined &&
              news.description !== workflow.description
            ) {
              patch.description = news.description;
            }
            if (
              news.storageType !== undefined &&
              news.storageType !== workflow.storageType
            ) {
              patch.storageType = news.storageType;
            }
            if (
              news.storageCapacity !== undefined &&
              news.storageCapacity !== workflow.storageCapacity
            ) {
              patch.storageCapacity = news.storageCapacity;
            }
            if (Object.keys(patch).length > 0) {
              yield* omics.updateWorkflow({ id: workflow.id, ...patch });
              workflow = yield* omics.getWorkflow({ id: workflow.id });
            }
          }

          yield* syncOmicsTags(workflow.arn!, desiredTags);

          yield* session.note(workflow.id!);
          return {
            workflowId: workflow.id!,
            workflowArn: workflow.arn!,
            name: workflow.name ?? name,
            status: workflow.status ?? "",
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* omics
            .deleteWorkflow({ id: output.workflowId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
