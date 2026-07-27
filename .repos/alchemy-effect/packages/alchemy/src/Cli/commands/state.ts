import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import { encodeState } from "../../State/StateEncoding.ts";
import * as Clank from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  importStack,
  instrumentCommand,
  profile,
  script,
  yes,
} from "./_shared.ts";

/**
 * When set, the State service is replaced with the on-disk
 * `LocalState` (`.alchemy/state` under the cwd) instead of whatever
 * the stack file configures (e.g. the Cloudflare HTTP state store).
 * Useful for inspecting orphaned local state after a partially-failed
 * bootstrap.
 */
const localFlag = Flag.boolean("local").pipe(
  Flag.withDescription(
    "Read from local .alchemy/state instead of the stack's configured state store",
  ),
  Flag.withDefault(false),
);

const stackFlag = Flag.string("stack").pipe(
  Flag.withDescription("Stack name (e.g. AlchemyEffectWebsite)"),
);

const stageFlag = Flag.string("stage").pipe(
  Flag.withDescription("Stage name (e.g. dev, prod)"),
);

const fqnFlag = Flag.string("fqn").pipe(
  Flag.withDescription("Fully-qualified resource name"),
);

/**
 * Build the layer stack used by every `alchemy state ...` subcommand.
 *
 * The stack file is imported and evaluated so that its `state` layer
 * (Cloudflare HTTP store, in-memory, etc.) is in scope. Pass `local`
 * to swap the configured State for an on-disk LocalState instead.
 *
 * The Stage service is only needed to build the stack's state layer;
 * state operations address (stack, stage) explicitly, so a placeholder
 * value (same as `alchemy unsafe nuke`) is sufficient.
 */
const withStateService = <A, E>(
  args: {
    main: string;
    envFile: Option.Option<string>;
    profile: string;
    local: boolean;
  },
  body: (state: State.StateService) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const stackEffect = yield* importStack(args.main);

    const services = Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(
        withProfileOverride(
          yield* loadConfigProvider(args.envFile),
          args.profile,
        ),
      ),
      Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
      Layer.succeed(Stage, "placeholder"),
      // When --local is set we still build the stack to get its other
      // services, but force State to be LocalState. Without --local the
      // stack's configured State (httpState, etc.) wins.
      args.local ? State.localState() : Layer.empty,
    );

    return yield* Effect.gen(function* () {
      const stack = yield* stackEffect;
      return yield* Effect.gen(function* () {
        const state = yield* yield* State.State;
        return yield* body(state);
      }).pipe(Effect.provide(stack.services));
    }).pipe(Effect.provide(services));
  });

const stacksCommand = Command.make(
  "stacks",
  { main: script, envFile, profile, local: localFlag },
  instrumentCommand("state.stacks")(
    Effect.fn(function* (args) {
      yield* withStateService(args, (state) =>
        Effect.gen(function* () {
          const stacks = yield* state.listStacks();
          if (stacks.length === 0) {
            yield* Console.log("(no stacks)");
            return;
          }
          for (const s of [...stacks].sort()) {
            yield* Console.log(s);
          }
        }),
      );
    }),
  ),
);

const stagesCommand = Command.make(
  "stages",
  { stack: stackFlag, main: script, envFile, profile, local: localFlag },
  instrumentCommand("state.stages")(
    Effect.fn(function* ({ stack: stackName, ...rest }) {
      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const stages = yield* state.listStages(stackName);
          if (stages.length === 0) {
            yield* Console.log(`(no stages in ${stackName})`);
            return;
          }
          for (const s of [...stages].sort()) {
            yield* Console.log(s);
          }
        }),
      );
    }),
  ),
);

const resourcesCommand = Command.make(
  "resources",
  {
    stack: stackFlag,
    stageName: stageFlag,
    main: script,
    envFile,
    profile,
    local: localFlag,
  },
  instrumentCommand("state.resources")(
    Effect.fn(function* ({ stack: stackName, stageName, ...rest }) {
      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const fqns = yield* state.list({
            stack: stackName,
            stage: stageName,
          });
          if (fqns.length === 0) {
            yield* Console.log(`(no resources in ${stackName}/${stageName})`);
            return;
          }
          for (const f of [...fqns].sort()) {
            yield* Console.log(f);
          }
        }),
      );
    }),
  ),
);

const getCommand = Command.make(
  "get",
  {
    stack: stackFlag,
    stageName: stageFlag,
    fqn: fqnFlag,
    main: script,
    envFile,
    profile,
    local: localFlag,
  },
  instrumentCommand("state.get")(
    Effect.fn(function* ({ stack: stackName, stageName, fqn, ...rest }) {
      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const value = yield* state.get({
            stack: stackName,
            stage: stageName,
            fqn,
          });
          if (value === undefined) {
            yield* Console.log(`(not found: ${stackName}/${stageName}/${fqn})`);
            return;
          }
          // encodeState produces a JSON-friendly view: redacted secrets
          // are unwrapped into `{ __redacted__: ... }`, Resources are
          // flattened, etc. Same shape the store persists.
          yield* Console.log(JSON.stringify(encodeState(value), null, 2));
        }),
      );
    }),
  ),
);

const treeCommand = Command.make(
  "tree",
  { main: script, envFile, profile, local: localFlag },
  instrumentCommand("state.tree")(
    Effect.fn(function* (args) {
      yield* withStateService(args, (state) =>
        Effect.gen(function* () {
          const stacks = [...(yield* state.listStacks())].sort();
          if (stacks.length === 0) {
            yield* Console.log("(empty state store)");
            return;
          }
          // Fetch the entire tree in parallel: for each stack, list its
          // stages; for each (stack, stage), list its resources. All
          // network round-trips happen concurrently; output is rendered
          // once at the end so the user doesn't see stuttered partial
          // output.
          const tree = yield* Effect.forEach(
            stacks,
            (stk) =>
              Effect.gen(function* () {
                const stages = [...(yield* state.listStages(stk))].sort();
                const stageEntries = yield* Effect.forEach(
                  stages,
                  (stg) =>
                    Effect.map(
                      state.list({ stack: stk, stage: stg }),
                      (fqns) => ({ stage: stg, fqns: [...fqns].sort() }),
                    ),
                  { concurrency: "unbounded" },
                );
                return { stack: stk, stages: stageEntries };
              }),
            { concurrency: "unbounded" },
          );

          const lines: string[] = [];
          for (const { stack: stk, stages } of tree) {
            lines.push(stk);
            for (let i = 0; i < stages.length; i++) {
              const { stage: stg, fqns } = stages[i]!;
              const stageBranch = i === stages.length - 1 ? "└─" : "├─";
              lines.push(`${stageBranch} ${stg}`);
              const indent = i === stages.length - 1 ? "   " : "│  ";
              for (let j = 0; j < fqns.length; j++) {
                const leaf = j === fqns.length - 1 ? "└─" : "├─";
                lines.push(`${indent}${leaf} ${fqns[j]}`);
              }
            }
          }
          yield* Console.log(lines.join("\n"));
        }),
      );
    }),
  ),
);

const clearStackFlag = Flag.string("stack").pipe(
  Flag.withDescription(
    "Stack name to clear. Omit to clear ALL stacks in the store.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const clearStageFlag = Flag.string("stage").pipe(
  Flag.withDescription(
    "Stage to clear within the stack. Omit to clear all stages in the stack.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

/**
 * Destructive: removes resource state from the store. The actual cloud
 * resources are NOT touched — this only affects what alchemy thinks
 * exists. Always confirms before deleting unless `--yes` is passed.
 */
const clearCommand = Command.make(
  "clear",
  {
    stack: clearStackFlag,
    stageName: clearStageFlag,
    main: script,
    envFile,
    profile,
    local: localFlag,
    yes,
  },
  instrumentCommand("state.clear")(
    Effect.fn(function* ({
      stack: stackName,
      stageName,
      yes: yesFlag,
      ...rest
    }) {
      if (stageName !== undefined && stackName === undefined) {
        yield* Console.log(
          "Error: cannot specify --stage without --stack. Pass the stack name via --stack.",
        );
        return yield* Effect.fail(new Error("missing stack"));
      }

      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const targets: ReadonlyArray<{ stack: string; stage?: string }> =
            stackName === undefined
              ? [...(yield* state.listStacks())]
                  .sort()
                  .map((s) => ({ stack: s }))
              : stageName === undefined
                ? [{ stack: stackName }]
                : [{ stack: stackName, stage: stageName }];

          if (targets.length === 0) {
            yield* Console.log("(nothing to clear)");
            return;
          }

          const scope =
            stackName === undefined
              ? `ALL stacks (${targets.length}): ${targets.map((t) => t.stack).join(", ")}`
              : stageName === undefined
                ? `stack '${stackName}' (all stages)`
                : `stage '${stageName}' in stack '${stackName}'`;

          if (!yesFlag) {
            const ok = yield* Clank.confirm({
              message: `About to delete ${scope} from the state store. This cannot be undone. Continue?`,
              initialValue: false,
            });
            if (!ok) {
              yield* Console.log("Cancelled.");
              return;
            }
          }

          yield* Effect.forEach(
            targets,
            (target) =>
              Effect.gen(function* () {
                yield* state.deleteStack(target);
                yield* Console.log(
                  `cleared ${target.stack}${target.stage ? `/${target.stage}` : ""}`,
                );
              }),
            { concurrency: 32 },
          );
        }),
      );
    }),
  ),
);

export const stateCommand = Command.make("state", {}).pipe(
  Command.withSubcommands([
    stacksCommand,
    stagesCommand,
    resourcesCommand,
    getCommand,
    treeCommand,
    clearCommand,
  ]),
);
