import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import type { Input } from "../Input.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export interface FunctionTriggerCommonProps {
  /** Branch-local target Function. */ function: {
    projectId: string;
    branchId: string;
    slug: string;
  };
  /** Unique name among visible triggers, including inherited ones. Generated when omitted. */ name?: string;
  /** POST delivery path, without a query string. @default "/" */ path?: string;
  /** Enable delivery. Inherited triggers remain disabled unless explicitly enabled. */ enabled?: boolean;
}
export type FunctionTriggerProps = FunctionTriggerCommonProps &
  (
    | {
        /** UTC schedule. */ type: "schedule";
        /** Numeric five-field cron configuration. */ schedule: {
          cron: string;
        };
        storageObjectCreated?: never;
      }
    | {
        /** Successful upload event. */ type: "storage_object_created";
        /** Same-branch bucket and optional byte-exact object-key prefix. */ storageObjectCreated: {
          bucket: { projectId: string; branchId: string; bucketName: string };
          prefix?: string;
        };
        schedule?: never;
      }
  );
export interface FunctionTriggerAttributes {
  /** Owning project. */ projectId: string;
  /** Owning branch. */ branchId: string;
  /** Project-wide trigger identifier. */ triggerId: string;
  /** Target Function slug. */ slug: string;
  /** Trigger name. */ name: string;
  /** Event type; changing it replaces the trigger. */ type:
    | "schedule"
    | "storage_object_created";
  /** Configured delivery route. */ path: string;
  /** Whether future delivery is enabled. */ enabled: boolean;
  /** Monotonic configuration version, not the event schema version. */ version: number;
  /** True when the configuration comes from an ancestor. */ inherited: boolean;
  /** Next cron time; absent for object events or disabled schedules. */ nextRunAt:
    | string
    | null
    | undefined;
}
export interface FunctionTrigger extends Resource<
  "Neon.FunctionTrigger",
  FunctionTriggerProps,
  FunctionTriggerAttributes,
  never,
  Providers
> {}

/**
 * Deliver scheduled or object-created events as HTTP POSTs to a Function.
 * For Effect handlers, prefer BucketEventSource or CronEventSource: they create
 * this resource and register its handler route together. Use FunctionTrigger
 * directly for an existing native HTTP handler.
 * Check the edge-attested header and validate the payload using
 * `decodeFunctionTriggerEvent`. Invocation IDs support application idempotency;
 * Alchemy does not promise exactly-once delivery or undocumented retries.
 *
 * ### Schedule a Function
 * **Example:** Nightly POST
 * ```typescript
 * const nightly = yield* Neon.FunctionTrigger("Nightly", {
 *   function: api, type: "schedule", schedule: { cron: "0 2 * * *" }, path: "/jobs/nightly",
 * });
 * ```
 *
 * ### Watch Uploads
 * **Example:** Process incoming objects
 * ```typescript
 * yield* Neon.FunctionTrigger("Uploads", {
 *   function: api, type: "storage_object_created",
 *   storageObjectCreated: { bucket: uploads, prefix: "incoming/" }, path: "/jobs/upload",
 * });
 * ```
 *
 * @resource
 * @product Function
 */
export const FunctionTrigger = Resource<FunctionTrigger>(
  "Neon.FunctionTrigger",
);
export class FunctionTriggerConfigurationError extends Data.TaggedError(
  "FunctionTriggerConfigurationError",
)<{ message: string }> {}
const scopeOf = (fn: { projectId: string; branchId: string }) => ({
  project_id: fn.projectId,
  branch_id: fn.branchId,
});
const observe = Effect.fn(function* (
  scope: { project_id: string; branch_id: string },
  identity: { id?: string; name?: string },
) {
  const { triggers } = yield* Neon.listProjectBranchTriggers(scope);
  return triggers.find((trigger) =>
    identity.id
      ? trigger.trigger_id === identity.id
      : trigger.name === identity.name,
  );
});
const attrs = (
  fn: { projectId: string; branchId: string },
  trigger: Neon.Trigger,
): FunctionTriggerAttributes => ({
  projectId: fn.projectId,
  branchId: fn.branchId,
  triggerId: trigger.trigger_id,
  slug: trigger.function_slug,
  name: trigger.name,
  type: trigger.type,
  path: trigger.function_path,
  enabled: trigger.enabled,
  version: trigger.version,
  inherited: trigger.inherited,
  nextRunAt: trigger.type === "schedule" ? trigger.next_run_at : undefined,
});
const desiredConfig = Effect.fn(function* (
  news: Input.Resolve<FunctionTriggerProps>,
  name: string,
  inherited: boolean,
) {
  const path = news.path ?? "/";
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  )
    return yield* new FunctionTriggerConfigurationError({
      message:
        "Trigger path must be an absolute path without query or fragment",
    });
  const common = {
    name,
    function_slug: news.function.slug,
    function_path: path,
    enabled: news.enabled ?? !inherited,
  };
  if (news.type === "schedule")
    return { ...common, type: "schedule" as const, schedule: news.schedule };
  const bucket = news.storageObjectCreated.bucket;
  if (
    bucket.projectId !== news.function.projectId ||
    bucket.branchId !== news.function.branchId
  )
    return yield* new FunctionTriggerConfigurationError({
      message: "Function and trigger bucket must belong to the same branch",
    });
  return {
    ...common,
    type: "storage_object_created" as const,
    storage_object_created: {
      bucket_name: bucket.bucketName,
      ...(news.storageObjectCreated.prefix
        ? { prefix: news.storageObjectCreated.prefix }
        : {}),
    },
  };
});
export const FunctionTriggerProvider = () =>
  Provider.succeed(FunctionTrigger, {
    stables: ["projectId", "branchId", "triggerId"],
    list: Effect.fn(function* () {
      const result: FunctionTriggerAttributes[] = [];
      for (const project of yield* Neon.listProjects
        .items({})
        .pipe(Stream.runCollect)) {
        for (const branch of yield* Neon.listProjectBranches
          .items({ project_id: project.id })
          .pipe(Stream.runCollect)) {
          const { triggers } = yield* Neon.listProjectBranchTriggers({
            project_id: project.id,
            branch_id: branch.id,
          });
          result.push(
            ...triggers.map((trigger) =>
              attrs({ projectId: project.id, branchId: branch.id }, trigger),
            ),
          );
        }
      }
      return result;
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || !output) return;
      if (
        news.type !== output.type ||
        news.function.projectId !== output.projectId ||
        news.function.branchId !== output.branchId
      )
        return { action: "replace", deleteFirst: true };
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (!output && !olds?.function) return undefined;
      const fn = output ?? olds!.function;
      const name =
        output?.name ??
        olds?.name ??
        (yield* createPhysicalName({ id, maxLength: 256 }));
      const found = yield* observe(scopeOf(fn), {
        id: output?.triggerId,
        name,
      });
      if (!found) return undefined;
      const result = attrs(fn, found);
      return output ? result : Unowned(result);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = scopeOf(news.function);
      const name =
        news.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 256 }));
      let current = yield* observe(scope, { id: output?.triggerId, name });
      const desired = yield* desiredConfig(
        news,
        name,
        current?.inherited ?? false,
      );
      if (!current)
        current = yield* Neon.createProjectBranchTrigger({
          ...scope,
          body: desired,
        }).pipe(
          Effect.map((response) => response.trigger),
          Effect.catchTag("Conflict", (error) =>
            observe(scope, { name }).pipe(
              Effect.flatMap((trigger) =>
                trigger ? Effect.succeed(trigger) : Effect.fail(error),
              ),
            ),
          ),
        );
      const observed = {
        name: current.name,
        function_slug: current.function_slug,
        function_path: current.function_path,
        enabled: current.enabled,
        ...(current.type === "schedule"
          ? { type: current.type, schedule: current.schedule }
          : {
              type: current.type,
              storage_object_created: current.storage_object_created,
            }),
      };
      if (JSON.stringify(observed) !== JSON.stringify(desired))
        current = (yield* Neon.updateProjectBranchTrigger({
          ...scope,
          trigger_id: current.trigger_id,
          body: desired,
        })).trigger;
      return attrs(news.function, current);
    }),
    delete: Effect.fn(function* ({ output }) {
      const scope = scopeOf(output);
      if (!(yield* observe(scope, { id: output.triggerId }))) return;
      yield* Neon.deleteProjectBranchTrigger({
        ...scope,
        trigger_id: output.triggerId,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
