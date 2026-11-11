// Workflows in the running server: definitions come from one module the operator names, and
// without one nothing here starts.
import * as NodeURL from "node:url";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { WorkflowDefinition } from "./workflow.ts";
import type * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowAgentThreads from "./WorkflowAgentThreads.ts";
import * as Workflows from "./Workflows.ts";

/** The module whose default export is the list of workflow definitions to register. */
const definitionsModule = Config.String("T3CODE_WORKFLOWS").pipe(Config.option);

export class WorkflowDefinitionsLoadError extends Schema.TaggedError<WorkflowDefinitionsLoadError>()(
  "WorkflowDefinitionsLoadError",
  { module: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not load workflow definitions from ${this.module}.`;
  }
}

const isDefinition = (value: unknown): value is WorkflowDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as WorkflowDefinition).name === "string" &&
  typeof (value as WorkflowDefinition).version === "number" &&
  typeof (value as WorkflowDefinition).body === "function";

/** A definitions module exports its workflows, or a function from the author API to them. */
export const loadDefinitions = Effect.fn("WorkflowRuntime.loadDefinitions")(function* (
  module: string,
) {
  const path = yield* Path.Path;
  const url = NodeURL.pathToFileURL(path.resolve(module)).href;
  const definitions = yield* Effect.tryPromise({
    try: async () => {
      const loaded = (await import(url)) as { readonly default?: unknown };
      return typeof loaded.default === "function"
        ? ((await loaded.default(await import("./api.ts"))) as unknown)
        : loaded.default;
    },
    catch: (cause) => new WorkflowDefinitionsLoadError({ module, cause }),
  });
  if (!Array.isArray(definitions) || !definitions.every(isDefinition)) {
    return yield* new WorkflowDefinitionsLoadError({
      module,
      cause: "It does not export an array of workflow definitions, or a function that returns one.",
    });
  }
  return definitions as ReadonlyArray<WorkflowDefinition>;
});

/**
 * The workflow service for this server. With no definitions module named it is the service with
 * nothing registered and no engine behind it, so a server that uses no workflows pays nothing.
 * Definitions that do not load are logged and leave workflows off; they never stop the server.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const module = yield* definitionsModule;
    if (Option.isNone(module)) return Workflows.layerDisabled;
    const definitions = yield* loadDefinitions(module.value);
    const engine = yield* Effect.promise(
      (): Promise<typeof WorkflowEngine> => import("./WorkflowEngine.ts"),
    );
    yield* Effect.logInfo("Workflows registered", {
      module: module.value,
      workflows: definitions.map((definition) => `${definition.name}@${definition.version}`),
    });
    return engine.layer(definitions).pipe(Layer.provide(WorkflowAgentThreads.layer));
  }).pipe(
    Effect.catchTags({
      WorkflowDefinitionsLoadError: (error) =>
        Effect.as(
          Effect.logError("Workflows are off: their definitions did not load", error),
          Workflows.layerDisabled,
        ),
    }),
  ),
);
