import {
  PluginCommand as PluginCommandSchema,
  type PluginCommand,
  type PluginCommandCatalog as PluginCommandCatalogSnapshot,
  PluginCommandCatalogChangedError,
  type PluginCommandInvocationResult,
  PluginCommandInvocationError,
  type PluginCommandInvokeInput,
  PluginCommandNotFoundError,
} from "@t3tools/contracts";
import type {
  Contribution,
  PluginActivationContext,
  PluginDefinition,
  PluginRuntimeSnapshot,
} from "@t3tools/plugin-runtime";
import { PluginRuntime } from "@t3tools/plugin-runtime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

const COMMAND_SLOT = "commands";
const decodePluginCommand = Schema.decodeUnknownSync(PluginCommandSchema);
const decodePluginCommandEffect = Schema.decodeUnknownEffect(PluginCommandSchema);
const isContributionGenerationError = Schema.is(PluginRuntime.PluginContributionGenerationError);
const isContributionNotFoundError = Schema.is(PluginRuntime.PluginContributionNotFoundError);

const commandInputFromContribution = (entry: Contribution) => {
  const data = typeof entry.data === "object" && entry.data !== null ? entry.data : {};
  if (Object.hasOwn(data, "id") || Object.hasOwn(data, "label")) {
    throw new TypeError("Plugin command metadata cannot override its registered id or label");
  }
  return { ...data, id: entry.id, label: entry.label };
};

const validateCommandSnapshot = (snapshot: PluginRuntimeSnapshot): void => {
  for (const entry of snapshot.contributions[COMMAND_SLOT] ?? []) {
    decodePluginCommand(commandInputFromContribution(entry));
  }
};

export class PluginCommandExecutionError extends Schema.TaggedErrorClass<PluginCommandExecutionError>()(
  "PluginCommandExecutionError",
  { cause: Schema.Defect() },
) {}

type PluginCommandHandler = Effect.Effect<
  PluginCommandInvocationResult,
  PluginCommandExecutionError
>;

export class PluginCommandDefinitionError extends Schema.TaggedErrorClass<PluginCommandDefinitionError>()(
  "PluginCommandDefinitionError",
  { cause: Schema.Defect(), id: Schema.String },
) {
  override get message(): string {
    return `Plugin command ${this.id} has invalid declarative metadata.`;
  }
}

export interface PluginCommandRegistration {
  readonly command: PluginCommand;
  readonly handler: PluginCommandHandler;
}

export const registerPluginCommand = (
  context: PluginActivationContext,
  registration: PluginCommandRegistration,
): void => {
  const command = decodePluginCommand(registration.command);
  const { description, surfaces } = command;
  context.register(
    COMMAND_SLOT,
    {
      id: command.id,
      label: command.label,
      data: {
        ...(description === undefined ? {} : { description }),
        surfaces,
      },
    },
    registration.handler,
  );
};

const builtInPlugin: PluginDefinition = {
  id: "t3.plugin-runtime.commands",
  version: "1.0.0",
  activate(context) {
    registerPluginCommand(context, {
      command: {
        id: "t3.plugin-runtime.status",
        label: "Check plugin runtime",
        description: "Verify that the environment plugin runtime is responding.",
        surfaces: ["web", "desktop", "mobile"],
      },
      handler: Effect.succeed({
        message: "Plugin runtime is active.",
        tone: "success",
      }),
    });
  },
};

const catalogFromRuntime = Effect.fn("PluginCommandCatalog.catalogFromRuntime")(function* (
  runtime: PluginRuntime.PluginRuntime["Service"],
) {
  const snapshot = yield* runtime.contributions(COMMAND_SLOT);
  const commands = yield* Effect.forEach(snapshot.entries, (entry) =>
    decodePluginCommandEffect(commandInputFromContribution(entry)).pipe(
      Effect.mapError((cause) => new PluginCommandDefinitionError({ cause, id: entry.id })),
    ),
  );
  const frozenCommands = commands.map((command) =>
    Object.freeze({ ...command, surfaces: Object.freeze([...command.surfaces]) }),
  );
  return Object.freeze({
    commands: Object.freeze(frozenCommands),
    generation: snapshot.generation,
  }) satisfies PluginCommandCatalogSnapshot;
});

export class PluginCommandCatalog extends Context.Service<
  PluginCommandCatalog,
  {
    readonly list: Effect.Effect<PluginCommandCatalogSnapshot>;
    readonly changes: Stream.Stream<PluginCommandCatalogSnapshot>;
    readonly invoke: (
      input: PluginCommandInvokeInput,
    ) => Effect.Effect<
      PluginCommandInvocationResult,
      PluginCommandCatalogChangedError | PluginCommandInvocationError | PluginCommandNotFoundError
    >;
    readonly reconcile: (
      definitions: ReadonlyArray<PluginDefinition>,
    ) => Effect.Effect<
      PluginCommandCatalogSnapshot,
      PluginCommandDefinitionError | PluginRuntime.PluginRuntimeReconcileError
    >;
  }
>()("t3/plugins/PluginCommandCatalog") {}

export const make = Effect.gen(function* () {
  const runtime = yield* PluginRuntime.PluginRuntime;
  const state = yield* SubscriptionRef.make<PluginCommandCatalogSnapshot>({
    commands: [],
    generation: 0,
  });
  const reconcileSemaphore = yield* Semaphore.make(1);

  const reconcile = Effect.fn("PluginCommandCatalog.reconcile")(
    (definitions: ReadonlyArray<PluginDefinition>) =>
      reconcileSemaphore.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const transitionExit = yield* Effect.exit(
              restore(runtime.reconcile([builtInPlugin, ...definitions])),
            );
            const catalog = yield* catalogFromRuntime(runtime);
            const previous = yield* SubscriptionRef.get(state);
            const published =
              previous.generation === catalog.generation
                ? previous
                : yield* SubscriptionRef.set(state, catalog).pipe(Effect.as(catalog));
            if (Exit.isFailure(transitionExit)) {
              return yield* Effect.failCause(transitionExit.cause);
            }
            return published;
          }),
        ),
      ),
  );

  yield* reconcile([]);

  const invoke = Effect.fn("PluginCommandCatalog.invoke")(function* (
    input: PluginCommandInvokeInput,
  ) {
    return yield* runtime
      .useContribution<
        PluginCommandHandler,
        PluginCommandInvocationResult,
        PluginCommandExecutionError,
        never
      >(COMMAND_SLOT, input.id, input.generation, (handler) => handler)
      .pipe(
        Effect.mapError((error) => {
          if (isContributionGenerationError(error)) {
            return new PluginCommandCatalogChangedError({
              actualGeneration: error.actual,
              expectedGeneration: error.expected,
            });
          }
          if (isContributionNotFoundError(error)) {
            return new PluginCommandNotFoundError({ id: input.id });
          }
          return new PluginCommandInvocationError({
            cause: error,
            id: input.id,
            message: "Plugin command failed.",
          });
        }),
      );
  });

  return PluginCommandCatalog.of({
    changes: SubscriptionRef.changes(state),
    invoke,
    list: SubscriptionRef.get(state),
    reconcile,
  });
});

export const layer = Layer.effect(PluginCommandCatalog, make).pipe(
  Layer.provide(PluginRuntime.layer({ validateSnapshot: validateCommandSnapshot })),
);
