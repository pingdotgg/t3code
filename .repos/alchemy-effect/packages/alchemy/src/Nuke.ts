import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Formatter from "effect/Formatter";
import * as Schedule from "effect/Schedule";
import picomatch from "picomatch";
import {
  isProviderCollectionService,
  isProviderService,
  type ProviderService,
} from "./Provider.ts";
import type { ProviderMode } from "./ProviderMode.ts";
import { stronglyConnectedComponents } from "./Util/scc.ts";

// Account-wide teardown: enumerate everything the registered providers can see
// and delete it, ignoring stack state entirely. This is the engine behind
// `alchemy nuke` — a blunt instrument for cleaning a test account, not part of
// any stack's lifecycle.

/** A provider call that failed. These are collected into results, never thrown. */
export interface ProviderFailure {
  readonly provider: string;
  readonly operation: "list" | "delete";
  readonly message: string;
}

/** One cloud object a provider's `list()` turned up, bound to its provider. */
export interface Target {
  readonly providerId: string;
  readonly displayName: string;
  readonly attributes: Record<string, unknown>;
  readonly provider: ProviderService;
}

export interface DiscoverOptions {
  readonly mode: ProviderMode;
  /** Provider-id globs to include. Omitted means every provider. */
  readonly include?: ReadonlyArray<string>;
  /** Provider-id globs to exclude. Applied after {@link DiscoverOptions.include}. */
  readonly exclude?: ReadonlyArray<string>;
}

export interface ListOptions extends DiscoverOptions {
  /** The built provider context — what a stack's `providers` layer produced. */
  readonly context: Context.Context<never>;
  readonly concurrency?: number | "unbounded";
  readonly timeoutSeconds?: number;
  /** Called once with the selected provider count before enumeration starts. */
  readonly onScan?: (total: number) => Effect.Effect<void>;
  /** Called when a provider starts resolving/listing, to identify slow scans. */
  readonly onProviderStarted?: (provider: string) => Effect.Effect<void>;
  /**
   * Called as each provider's listing settles (0 resources when it failed),
   * for progress reporting — scans across many providers are the slowest
   * part of a nuke and would otherwise be silent until the summary.
   */
  readonly onProvider?: (
    provider: string,
    resources: number,
    error?: string,
  ) => Effect.Effect<void>;
}

export type Strategy =
  /** Delete in dependency order, retrying a wave until it stops making progress. */
  | { readonly _tag: "coordinated" }
  /** Delete everything at once, retrying each object on its own. */
  | { readonly _tag: "independent"; readonly retries: number };

export interface DestroyOptions {
  readonly targets: ReadonlyArray<Target>;
  readonly context: Context.Context<never>;
  readonly strategy: Strategy;
  readonly concurrency?: number | "unbounded";
  readonly timeoutSeconds?: number;
  /** Called before each coordinated pass, or once for independent deletion. */
  readonly onPass?: (pass: number) => Effect.Effect<void>;
  /** Called before each deletion attempt. */
  readonly onDeleting?: (resource: Target) => Effect.Effect<void>;
  /** Called when dependency failures prevent a resource from being attempted. */
  readonly onHeld?: (
    resource: Target,
    blockedBy: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  /** Called as each object is confirmed gone, for progress reporting. */
  readonly onDeleted?: (resource: Target) => Effect.Effect<void>;
  /** Called as a deletion attempt fails permanently (the run keeps going). */
  readonly onFailed?: (
    resource: Target,
    message: string,
  ) => Effect.Effect<void>;
}

export interface Result {
  readonly requested: number;
  readonly deleted: ReadonlyArray<Target>;
  readonly failed: ReadonlyArray<{
    readonly resource: Target;
    readonly failure: ProviderFailure;
  }>;
  /** Skipped because something they depend on could not be deleted first. */
  readonly held: ReadonlyArray<{
    readonly resource: Target;
    readonly blockedBy: ReadonlyArray<string>;
  }>;
  readonly passes: number;
}

interface DiscoveredProvider {
  readonly id: string;
  readonly resolve: Effect.Effect<ProviderService>;
}

const failure = (
  provider: string,
  operation: ProviderFailure["operation"],
  cause: unknown,
): ProviderFailure => ({
  provider,
  operation,
  message: typeof cause === "string" ? cause : Formatter.format(cause),
});

/** Deletions here run out-of-band, so nothing reports through an apply session. */
const silent = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};

/**
 * Walk the built provider context for everything deletable. A provider opts
 * out with `nuke.skip` (not ours to delete) or `nuke.singleton` (an
 * account-level object that has to survive).
 */
const discover = (
  context: Context.Context<never>,
  { mode, include, exclude }: DiscoverOptions,
): ReadonlyArray<DiscoveredProvider> => {
  const output = new Map<string, ProviderService>();
  const nukeable = (provider: ProviderService) =>
    !provider.nuke?.singleton && !provider.nuke?.skip;
  for (const [key, value] of context.mapUnsafe.entries()) {
    if (isProviderCollectionService(value)) {
      for (const [id, provider] of Object.entries(value.providers)) {
        if (nukeable(provider)) output.set(id, provider);
      }
    } else if (
      typeof key === "string" &&
      key.includes(".") &&
      isProviderService(value) &&
      nukeable(value)
    ) {
      output.set(key, value);
    }
  }
  const included = include?.length ? picomatch([...include]) : () => true;
  const excluded = exclude?.length ? picomatch([...exclude]) : () => false;
  return [...output.entries()]
    .flatMap(([id, provider]) => {
      if (!included(id) || excluded(id)) return [];
      if (mode === "live") return [{ id, resolve: Effect.succeed(provider) }];
      return provider.modes?.local
        ? [{ id, resolve: provider.modes.local }]
        : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};
const nameKeys = [
  "workerName",
  "functionName",
  "bucketName",
  "tableName",
  "queueName",
  "repositoryName",
  "databaseName",
  "projectName",
  "domainName",
  "hostname",
  "displayName",
  "name",
];

const displayName = (attributes: Record<string, unknown>) =>
  nameKeys
    .map((key) => attributes[key])
    .find(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ??
  Object.values(attributes).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  ) ??
  "unknown";

const groupBy = <T>(items: ReadonlyArray<T>, key: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return groups;
};

const addEdge = (edges: Map<string, Set<string>>, from: string, to: string) => {
  const values = edges.get(from) ?? new Set<string>();
  values.add(to);
  edges.set(from, values);
};

/** Ask every selected provider what exists. Provider failures are collected, not thrown. */
export const list = (
  options: ListOptions,
): Effect.Effect<{
  readonly resources: ReadonlyArray<Target>;
  readonly failures: ReadonlyArray<ProviderFailure>;
}> =>
  Effect.gen(function* () {
    const failures: ProviderFailure[] = [];
    const resources: Target[] = [];
    const providers = discover(options.context, options);
    yield* options.onScan?.(providers.length) ?? Effect.void;
    yield* Effect.forEach(
      providers,
      ({ id, resolve }) =>
        Effect.gen(function* () {
          yield* options.onProviderStarted?.(id) ?? Effect.void;
          const result = yield* Effect.result(
            Effect.gen(function* () {
              const provider = yield* resolve;
              const listed = yield* provider
                .list()
                .pipe(
                  Effect.timeout(
                    Duration.seconds(options.timeoutSeconds ?? 120),
                  ),
                );
              return { provider, listed };
            }).pipe(Effect.provide(options.context)),
          );
          if (result._tag === "Failure") {
            const error = failure(id, "list", result.failure);
            failures.push(error);
            yield* options.onProvider?.(id, 0, error.message) ?? Effect.void;
            return;
          }
          for (const raw of result.success.listed) {
            const attributes = (raw ?? {}) as Record<string, unknown>;
            resources.push({
              providerId: id,
              displayName: displayName(attributes),
              attributes,
              provider: result.success.provider,
            });
          }
          yield* (
            options.onProvider?.(id, result.success.listed.length) ??
              Effect.void
          );
        }),
      { concurrency: options.concurrency ?? 16, discard: true },
    );
    return { resources, failures };
  });

/** Delete the given targets under the chosen {@link Strategy}. */
export const destroy = ({
  targets,
  context,
  strategy,
  concurrency = 16,
  timeoutSeconds = 120,
  onDeleted = () => Effect.void,
  onFailed = () => Effect.void,
  onPass = () => Effect.void,
  onDeleting = () => Effect.void,
  onHeld = () => Effect.void,
}: DestroyOptions): Effect.Effect<Result> =>
  Effect.gen(function* () {
    const deleted: Target[] = [];
    const failed: Array<Result["failed"][number]> = [];
    const held: Array<Result["held"][number]> = [];
    let passes = 0;
    // Account-wide scans have no state rows: delete must derive identity from
    // `output` alone — `olds` just mirrors it and `instanceId` is unavailable.
    const attempt = (resource: Target) =>
      Effect.gen(function* () {
        yield* onDeleting(resource);
        return yield* resource.provider
          .delete({
            id: resource.displayName,
            fqn: resource.displayName,
            instanceId: "",
            olds: resource.attributes as never,
            output: resource.attributes as never,
            session: silent,
            bindings: [],
            force: true,
          })
          .pipe(
            Effect.timeout(Duration.seconds(timeoutSeconds)),
            Effect.provide(context),
          );
      });

    if (strategy._tag === "independent") {
      passes = 1;
      yield* onPass(passes);
      yield* Effect.forEach(
        targets,
        (resource) =>
          Effect.result(
            attempt(resource).pipe(
              Effect.retry({
                schedule: Schedule.min([
                  Schedule.exponential("1 second"),
                  Schedule.spaced("15 seconds"),
                ]),
                times: strategy.retries,
              }),
            ),
          ).pipe(
            Effect.tap((result) => {
              if (result._tag === "Success") {
                deleted.push(resource);
                return onDeleted(resource);
              }
              const why = failure(
                resource.providerId,
                "delete",
                result.failure,
              );
              failed.push({ resource, failure: why });
              return onFailed(resource, why.message);
            }),
          ),
        { concurrency: concurrency, discard: true },
      );
    } else {
      const typeIds = [...new Set(targets.map(({ providerId }) => providerId))];
      const providerOf = new Map(
        targets.map(({ providerId, provider }) => [providerId, provider]),
      );
      const successors = new Map<string, Set<string>>();
      const predecessors = new Map<string, Set<string>>();
      for (const id of typeIds) {
        const globs = providerOf.get(id)?.nuke?.dependsOn;
        if (!globs?.length) continue;
        const matches = picomatch([...globs]);
        for (const other of typeIds) {
          if (other === id || !matches(other)) continue;
          addEdge(successors, id, other);
          addEdge(predecessors, other, id);
        }
      }
      const grouped = stronglyConnectedComponents(
        typeIds,
        (id) => successors.get(id) ?? [],
      );
      const componentOf = new Map<string, number>();
      grouped.forEach((component, index) =>
        component.forEach((id) => componentOf.set(id, index)),
      );
      const layerOf = grouped.map(() => 0);
      for (let index = grouped.length - 1; index >= 0; index--) {
        for (const id of grouped[index]!) {
          for (const predecessor of predecessors.get(id) ?? []) {
            const predecessorComponent = componentOf.get(predecessor)!;
            if (predecessorComponent !== index) {
              layerOf[index] = Math.max(
                layerOf[index]!,
                layerOf[predecessorComponent]! + 1,
              );
            }
          }
        }
      }
      const waves: string[][] = [];
      grouped.forEach((component, index) =>
        (waves[layerOf[index]!] ??= []).push(...component),
      );
      const byType = groupBy(targets, ({ providerId }) => providerId);
      const remainingCount = new Map(
        [...byType].map(([id, resources]) => [id, resources.length]),
      );
      for (const wave of waves) {
        let runnable: Target[] = [];
        const heldTypes = new Set<string>();
        for (const typeId of wave) {
          const resources = byType.get(typeId) ?? [];
          const blockers = [...(predecessors.get(typeId) ?? [])].filter(
            (predecessor) =>
              componentOf.get(predecessor) !== componentOf.get(typeId) &&
              (remainingCount.get(predecessor) ?? 0) > 0,
          );
          if (blockers.length > 0) {
            heldTypes.add(typeId);
            yield* Effect.forEach(resources, (resource) =>
              onHeld(resource, blockers),
            );
            held.push(
              ...resources.map((resource) => ({
                resource,
                blockedBy: blockers,
              })),
            );
          } else runnable = [...runnable, ...resources];
        }
        let remaining = runnable;
        while (remaining.length > 0) {
          passes += 1;
          yield* onPass(passes);
          const results = yield* Effect.forEach(
            remaining,
            (resource) =>
              Effect.gen(function* () {
                const result = yield* Effect.result(attempt(resource));
                if (result._tag === "Success") {
                  deleted.push(resource);
                  yield* onDeleted(resource);
                }
                return { resource, result };
              }),
            { concurrency: concurrency },
          );
          const next: Target[] = [];
          for (const { resource, result } of results) {
            if (result._tag === "Failure") next.push(resource);
          }
          if (next.length === remaining.length) {
            for (const { resource, result } of results) {
              if (result._tag !== "Failure") continue;
              const why = failure(
                resource.providerId,
                "delete",
                result.failure,
              );
              failed.push({ resource, failure: why });
              yield* onFailed(resource, why.message);
            }
            break;
          }
          remaining = next;
        }
        const failuresByType = groupBy(
          failed.map(({ resource }) => resource),
          ({ providerId }) => providerId,
        );
        for (const typeId of wave) {
          // Held types were never attempted: keep their full count so waves
          // gated on them stay blocked instead of seeing a spurious zero.
          if (heldTypes.has(typeId)) continue;
          remainingCount.set(typeId, failuresByType.get(typeId)?.length ?? 0);
        }
      }
    }
    return {
      requested: targets.length,
      deleted,
      failed,
      held,
      passes,
    } satisfies Result;
  });
