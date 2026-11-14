import { pathToFileURL } from "node:url";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { emit } from "../Events.ts";
import type { ConfiguredStack } from "../Stack.ts";
import { UserFacingError } from "../UserFacingError.ts";

export class StackEntrypointError extends Data.TaggedError("StackEntrypointError")<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

export const DEFAULT_ENTRYPOINT = "alchemy.run.ts";

/**
 * The absolute path of the stack entrypoint, or the user-facing error for
 * a missing one. Kept free of the engine so the `alchemy dev` supervisor can
 * check the entry before it starts an exec child.
 */
export const resolveStackEntrypoint = Effect.fn(function* (main: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.resolve(main);
  if (!(yield* fs.exists(absolutePath))) {
    return yield* new StackEntrypointError({
      message: `Stack entrypoint '${main}' does not exist in '${path.dirname(absolutePath)}'. Run this command from an Alchemy project or pass --config <path>.`,
    });
  }
  return absolutePath;
});

export interface StackModuleLoader {
  readonly import: (url: string) => Promise<{ readonly default?: unknown }>;
}

export const StackModuleLoader = Context.Reference<StackModuleLoader>(
  "Alchemy/Alchemist/StackModuleLoader",
  { defaultValue: () => ({ import: (url) => import(url) }) },
);

/**
 * Import a stack entrypoint and return its default export, the stack value
 * every stack operation takes.
 */
export const importStack = Effect.fn("Alchemist.importStack")(function* (main: string) {
  yield* emit({ type: "plan.phase", phase: "importing-module" });
  const absolutePath = yield* resolveStackEntrypoint(main);
  const loader = yield* StackModuleLoader;
  const module = yield* Effect.promise(() => loader.import(pathToFileURL(absolutePath).href));
  if (
    !Effect.isEffect(module.default) ||
    !Predicate.hasProperty(module.default, "stackName") ||
    typeof module.default.stackName !== "string"
  ) {
    return yield* new StackEntrypointError({
      message: `Stack entrypoint '${main}' must export a default stack definition (export default Alchemy.Stack({...})).`,
    });
  }
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- default export shape validated at runtime above
  return module.default as ConfiguredStack<unknown, unknown>;
});

/**
 * Which project and credentials an operation acts under. The optional fields
 * fall back to the same defaults the CLI uses.
 */
export interface Target {
  /** Stack entrypoint. @default "alchemy.run.ts" */
  readonly entrypoint?: string;
  /** Profile whose credentials the run uses. Falls back to the active profile. */
  readonly profile?: string;
  /** `.env` file layered under the process environment. */
  readonly envFile?: string;
}
