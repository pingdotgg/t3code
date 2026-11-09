import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { findProviderByType } from "../Provider.ts";
import { stampedMode } from "../ProviderMode.ts";
import type { ConfiguredStack } from "../Stack.ts";
import * as State from "../State/index.ts";
import { AlchemistInvalidInput } from "./Errors.ts";
import { buildStack, type BuildOptions } from "./Operations.ts";

export interface ResourceIdentity {
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
}

export interface LogResource extends ResourceIdentity {
  readonly supportsQuery: boolean;
  readonly supportsTail: boolean;
}

export interface LogEntry {
  readonly resource: ResourceIdentity;
  readonly timestamp: Date;
  readonly message: string;
}

export interface LogOptions extends BuildOptions {
  readonly stack: ConfiguredStack<unknown, unknown>;
  /** Logical IDs to include. Empty or omitted means every resource. */
  readonly resources?: ReadonlyArray<string>;
}

export interface QueryOptions extends LogOptions {
  readonly limit?: number;
  readonly since?: Date;
}

/**
 * Build the stack and pair every deployed resource with the provider that
 * can speak for it. `entries` and `tail` differ only in which provider hook
 * they then call, so the selection lives here once. The build lives in the
 * ambient `Scope`; each public function closes its own.
 */
const select = Effect.fn(function* (input: LogOptions) {
  const built = yield* buildStack(input.stack, input);
  const context = built.context;
  const selected = new Set(input.resources ?? []);
  const available = [
    ...new Set(Object.values(built.stack.resources).map((resource) => resource.LogicalId)),
  ].sort();
  const unknown = [...selected].find((name) => !available.includes(name));
  if (unknown !== undefined) {
    return yield* new AlchemistInvalidInput({
      field: "resources",
      message: `Unknown resource '${unknown}'. Available: ${available.join(", ") || "(none)"}`,
    });
  }
  const rows = yield* Effect.provide(
    Effect.gen(function* () {
      const state = yield* Effect.flatten(State.State);
      return yield* Effect.forEach(Object.entries(built.stack.resources), ([fqn, resource]) =>
        Effect.gen(function* () {
          if (selected.size > 0 && !selected.has(resource.LogicalId)) {
            return [];
          }
          const stored = yield* state.get({
            stack: built.stack.name,
            stage: built.stack.stage,
            fqn,
          });
          if (!State.isResourceState(stored) || stored.attr === undefined) {
            return [];
          }
          return [
            {
              resource: {
                fqn,
                logicalId: resource.LogicalId,
                resourceType: resource.Type,
              } satisfies ResourceIdentity,
              provider: yield* findProviderByType(resource.Type, stampedMode(stored)),
              request: {
                id: resource.LogicalId,
                fqn,
                instanceId: stored.instanceId,
                props: stored.props,
                output: stored.attr,
              },
            },
          ];
        }),
      ).pipe(Effect.map((rows) => rows.flat()));
    }),
    context,
  );
  return { context, rows };
});

/** Every deployed resource, with the log capabilities its provider offers. */
export const resources = Effect.fn("Alchemist.Logs.resources")(function* (
  options: BuildOptions & { readonly stack: ConfiguredStack<unknown, unknown> },
) {
  const { rows } = yield* select(options);
  return rows.map(({ resource, provider }): LogResource => ({
    ...resource,
    supportsQuery: provider.logs !== undefined,
    supportsTail: provider.tail !== undefined,
  }));
}, Effect.scoped);

/** Query past log entries across the selected resources, oldest first. */
export const entries = Effect.fn("Alchemist.Logs.entries")(function* (input: QueryOptions) {
  const { context, rows } = yield* select(input);
  const entries = yield* Effect.provide(
    Effect.forEach(rows, ({ resource, provider, request }) =>
      provider.logs === undefined
        ? Effect.succeed([])
        : provider
            .logs({
              ...request,
              options: {
                limit: input.limit ?? 100,
                since: input.since,
              },
            })
            .pipe(
              Effect.map((lines) =>
                lines.map((line) => ({
                  resource,
                  timestamp: line.timestamp,
                  message: line.message,
                })),
              ),
            ),
    ),
    context,
  );
  return entries.flat().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}, Effect.scoped);

/** Live-stream log entries from every selected resource that supports it. */
export const tail = (input: LogOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { context, rows } = yield* select(input);
      return Stream.mergeAll(
        rows.flatMap(({ resource, provider, request }) =>
          provider.tail === undefined
            ? []
            : [
                Stream.provide(provider.tail(request), context).pipe(
                  Stream.map((line): LogEntry => ({
                    resource,
                    timestamp: line.timestamp,
                    message: line.message,
                  })),
                ),
              ],
        ),
        { concurrency: "unbounded" },
      );
    }),
  );
