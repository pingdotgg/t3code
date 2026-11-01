import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import * as Provider from "../Provider.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { sha256Object } from "../Util/sha256.ts";
import { resolveBranchScope, type ResolvedBranchScope } from "./BranchScope.ts";
import { Function, type FunctionAttributes } from "./Function.ts";
import { buildFunctionArtifact } from "./FunctionArtifact.ts";
import { functionEnvironment, functionSlug } from "./FunctionConfig.ts";
import { LocalFunctionProvider } from "./LocalFunctionProvider.ts";

export class FunctionDeploymentFailed extends Data.TaggedError(
  "FunctionDeploymentFailed",
)<{
  slug: string;
  deploymentId: number;
  status: string;
  message?: string;
}> {}
export class FunctionDeploymentNotReady extends Data.TaggedError(
  "FunctionDeploymentNotReady",
)<{ slug: string; deploymentId: number }> {}

export const observeFunction = Effect.fn(function* (
  scope: ResolvedBranchScope,
  slug: string,
) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = yield* Neon.listProjectBranchFunctions({
      project_id: scope.projectId,
      branch_id: scope.branchId,
      cursor,
    });
    const found = page.functions.find((fn) => fn.slug === slug);
    if (found) return found;
    cursor = page.pagination?.next;
    if (cursor && seen.has(cursor))
      return yield* new FunctionDeploymentFailed({
        slug,
        deploymentId: 0,
        status: "repeated-pagination-cursor",
        message: "Neon Function listing returned a repeated pagination cursor",
      });
    if (cursor) seen.add(cursor);
  } while (cursor);
  return undefined;
});

const attributes = (
  scope: ResolvedBranchScope,
  fn: Neon.NeonFunction,
  codeHash?: string,
  environmentHash?: string,
): FunctionAttributes => ({
  ...scope,
  functionId: fn.id,
  slug: fn.slug,
  name: fn.name,
  url: fn.invocation_url,
  currentDeploymentId: fn.current_deployment?.id,
  activeDeploymentId: fn.active_deployment?.id,
  status: fn.current_deployment?.status,
  codeHash,
  environmentHash,
  environment: fn.active_deployment?.environment ?? [],
});

export const waitForFunctionDeployment = (
  scope: ResolvedBranchScope,
  slug: string,
  deploymentId: number,
) =>
  Effect.gen(function* () {
    const { function: fn } = yield* Neon.getProjectBranchFunction({
      project_id: scope.projectId,
      branch_id: scope.branchId,
      slug,
    });
    if (
      fn.current_deployment?.id === deploymentId &&
      fn.current_deployment.status === "failed"
    ) {
      return yield* new FunctionDeploymentFailed({
        slug,
        deploymentId,
        status: "failed",
        message:
          fn.current_deployment.error ?? "Neon Function deployment failed",
      });
    }
    if (
      fn.active_deployment?.id !== deploymentId ||
      fn.active_deployment.status !== "completed" ||
      !fn.invocation_url.startsWith("https://")
    ) {
      return yield* new FunctionDeploymentNotReady({ slug, deploymentId });
    }
    return fn;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "FunctionDeploymentNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 9,
    }),
  );

export class FunctionLogQueryError extends Data.TaggedError(
  "FunctionLogQueryError",
)<{
  reason: "invalid-limit" | "invalid-cursor" | "pagination-limit";
}> {}

export const FunctionLogs = Effect.fn(function* (
  output: FunctionAttributes,
  options: Provider.LogsInput,
) {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 8000)
    return yield* new FunctionLogQueryError({ reason: "invalid-limit" });
  // https://neon.com/docs/introduction/monitor-logs documents this service identity.
  const service = `neon-function/${output.slug}`;
  const query = yield* Effect.sync(() => ({
    project_id: output.projectId,
    branch_id: output.branchId,
    source: "function" as const,
    service_name: service,
    ...(options.since
      ? { start_time: options.since.toISOString() }
      : { since: "1h" }),
    end_time: new Date().toISOString(),
    limit: Math.min(limit, 1000),
    sort_order: "desc" as const,
  }));
  const records: Neon.ProjectBranchLogRecord[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const response = yield* Neon.queryProjectBranchLogs({ ...query, cursor });
    records.push(
      ...response.logs.filter(
        (line) => line.source === "function" && line.service_name === service,
      ),
    );
    if (records.length >= limit || !response.is_truncated)
      return yield* Effect.sync(() =>
        records
          .slice(0, limit)
          .reverse()
          .map((line) => ({
            timestamp: new Date(line.timestamp),
            message: line.message,
          })),
      );
    cursor = response.next_cursor;
    if (!cursor || cursors.has(cursor))
      return yield* new FunctionLogQueryError({ reason: "invalid-cursor" });
    cursors.add(cursor);
  }
  return yield* new FunctionLogQueryError({ reason: "pagination-limit" });
}, Effect.timeout("45 seconds"));

export const FunctionProvider = () =>
  ProviderLayer.dual(Function, {
    live: FunctionProviderLive,
    local: LocalFunctionProvider,
  });

export const FunctionProviderLive = () =>
  Provider.succeed(Function, {
    stables: ["projectId", "branchId", "functionId", "slug", "url"],
    list: Effect.fn(function* () {
      const result: FunctionAttributes[] = [];
      for (const project of yield* Neon.listProjects
        .items({})
        .pipe(Stream.runCollect)) {
        for (const branch of yield* Neon.listProjectBranches
          .items({ project_id: project.id })
          .pipe(Stream.runCollect)) {
          const scope = { projectId: project.id, branchId: branch.id };
          for (const fn of yield* Neon.listProjectBranchFunctions
            .items({ project_id: project.id, branch_id: branch.id })
            .pipe(Stream.runCollect))
            result.push(attributes(scope, fn));
        }
      }
      return result;
    }),
    diff: Effect.fn(function* ({ id, news, output }) {
      if (!isResolved(news)) return;
      const scope = yield* resolveBranchScope(news);
      if (
        output &&
        (scope.projectId !== output.projectId ||
          scope.branchId !== output.branchId ||
          (news.slug !== undefined && news.slug !== output.slug))
      )
        return { action: "replace" };
      yield* functionSlug(id, news.slug);
      const artifact = yield* buildFunctionArtifact(news);
      if (artifact.codeHash !== output?.codeHash) return { action: "update" };
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (
        !output &&
        !(olds?.branch?.projectId && olds.branch.branchId) &&
        !olds?.project?.projectId
      )
        return undefined;
      const scope = output ?? (yield* resolveBranchScope(olds!));
      const slug = output?.slug ?? (yield* functionSlug(id, olds?.slug));
      const found = yield* observeFunction(scope, slug);
      if (!found) return undefined;
      const attrs = attributes(
        scope,
        found,
        output?.activeDeploymentId === found.active_deployment?.id
          ? output?.codeHash
          : undefined,
        output?.activeDeploymentId === found.active_deployment?.id
          ? output?.environmentHash
          : undefined,
      );
      return output ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const scope = yield* resolveBranchScope(news);
      const slug = news.slug ?? output?.slug ?? (yield* functionSlug(id));
      yield* functionSlug(id, slug);
      const observed = yield* observeFunction(scope, slug);
      const artifact = yield* buildFunctionArtifact(news);
      const env = yield* functionEnvironment(news, bindings);
      const stack = yield* Stack;
      const stage = yield* Stage;
      const managed = {
        ...env,
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stage,
        ALCHEMY_PHASE: "runtime",
      };
      const environment = {
        ...Object.fromEntries(
          (observed?.active_deployment?.environment ?? [])
            .filter((key) => !(key in managed))
            .map((key) => [key, ""]),
        ),
        ...managed,
      };
      const unchangedCode =
        observed !== undefined &&
        output?.activeDeploymentId === observed.active_deployment?.id &&
        output?.codeHash === artifact.codeHash;
      const environmentHash = yield* sha256Object(managed);
      const unchangedEnvironment =
        output?.activeDeploymentId === observed?.active_deployment?.id &&
        output?.environmentHash === environmentHash;
      let current = observed;
      if (!current || !unchangedCode || !unchangedEnvironment) {
        const zip = unchangedCode
          ? undefined
          : yield* Effect.sync(
              () =>
                new File([new Uint8Array(artifact.archive)], "function.zip", {
                  type: "application/zip",
                }),
            );
        const deployment = yield* Neon.createProjectBranchFunctionDeployment({
          project_id: scope.projectId,
          branch_id: scope.branchId,
          slug,
          runtime: "nodejs24",
          zip,
          environment: JSON.stringify(environment),
        });
        current = yield* waitForFunctionDeployment(
          scope,
          slug,
          deployment.deployment.id,
        );
      }
      if (current.name !== (news.name ?? slug)) {
        const updated = yield* Neon.updateProjectBranchFunction({
          project_id: scope.projectId,
          branch_id: scope.branchId,
          slug,
          name: news.name ?? null,
        });
        current = updated.function;
      }
      return attributes(scope, current, artifact.codeHash, environmentHash);
    }),
    delete: Effect.fn(function* ({ output }) {
      if (!(yield* observeFunction(output, output.slug))) return;
      yield* Neon.deleteProjectBranchFunction({
        project_id: output.projectId,
        branch_id: output.branchId,
        slug: output.slug,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
    logs: ({ output, options }) => FunctionLogs(output, options),
    tail: ({ output }) =>
      Stream.unwrap(
        Effect.sync(() => {
          const seen = new Set<string>();
          return Stream.fromEffectSchedule(
            FunctionLogs(output, { limit: 1000 }),
            Schedule.spaced("3 seconds"),
          ).pipe(
            Stream.flatMap((lines) => Stream.fromIterable(lines)),
            Stream.filter((line) => {
              const key = `${line.timestamp.toISOString()}\0${line.message}`;
              if (seen.has(key)) return false;
              seen.add(key);
              if (seen.size > 1000) seen.delete(seen.values().next().value!);
              return true;
            }),
          );
        }),
      ),
  });
