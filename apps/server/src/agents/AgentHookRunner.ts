import type { AgentHook, AgentHookStage, AgentProfileDocument } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;

export class AgentHookBlockedError extends Schema.TaggedErrorClass<AgentHookBlockedError>()(
  "AgentHookBlockedError",
  { stage: Schema.String, detail: Schema.String },
) {}

class AgentHookExecutionError extends Schema.TaggedErrorClass<AgentHookExecutionError>()(
  "AgentHookExecutionError",
  { detail: Schema.String },
) {}

const executionError = (cause: unknown) =>
  new AgentHookExecutionError({
    detail: cause instanceof Error ? cause.message : "Agent hook execution failed.",
  });

export interface AgentHookRunResult {
  readonly context: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export class AgentHookRunner extends Context.Service<
  AgentHookRunner,
  {
    readonly run: (input: {
      readonly profile: AgentProfileDocument;
      readonly stage: AgentHookStage;
      readonly workspaceRoot: string;
    }) => Effect.Effect<AgentHookRunResult, AgentHookBlockedError>;
  }
>()("t3/agents/AgentHookRunner") {}

const isContained = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;

  const runHook = Effect.fn("AgentHookRunner.runHook")(function* (
    hook: AgentHook,
    workspaceRoot: string,
  ) {
    if (hook.kind === "shell") {
      const invocation =
        platform === "win32"
          ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", hook.command] }
          : { command: "/bin/sh", args: ["-lc", hook.command] };
      const result = yield* processRunner
        .run({
          ...invocation,
          cwd: workspaceRoot,
          timeout: `${hook.timeoutSeconds} seconds`,
          maxOutputBytes: MAX_HOOK_OUTPUT_BYTES,
          outputMode: "truncate",
          truncatedMarker: "\n[hook output truncated]",
        })
        .pipe(Effect.mapError(executionError));
      if (result.code !== 0) {
        return yield* new AgentHookExecutionError({
          detail: result.stderr.trim() || `Hook exited with code ${result.code ?? "unknown"}.`,
        });
      }
      return result.stdout.trim();
    }

    if (path.isAbsolute(hook.path)) {
      return yield* new AgentHookExecutionError({
        detail: "Context hook paths must be workspace-relative.",
      });
    }
    const root = yield* fileSystem.realPath(workspaceRoot).pipe(Effect.mapError(executionError));
    const candidate = yield* fileSystem
      .realPath(path.resolve(root, hook.path))
      .pipe(Effect.mapError(executionError));
    if (!isContained(path, root, candidate)) {
      return yield* new AgentHookExecutionError({
        detail: "Context hook path resolves outside the workspace.",
      });
    }
    return yield* fileSystem.readFileString(candidate).pipe(
      Effect.map((contents) =>
        Buffer.byteLength(contents, "utf8") > MAX_HOOK_OUTPUT_BYTES
          ? `${contents.slice(0, MAX_HOOK_OUTPUT_BYTES)}\n[hook context truncated]`
          : contents,
      ),
      Effect.mapError(executionError),
    );
  });

  const run: AgentHookRunner["Service"]["run"] = Effect.fn("AgentHookRunner.run")(
    function* (input) {
      const context: string[] = [];
      const warnings: string[] = [];
      for (const hook of input.profile.hooks.filter(
        (candidate) => candidate.stage === input.stage,
      )) {
        const result = yield* runHook(hook, input.workspaceRoot).pipe(Effect.result);
        if (result._tag === "Success") {
          if (result.success.length > 0) context.push(result.success);
          continue;
        }
        const detail = result.failure.detail;
        if (hook.failurePolicy === "block") {
          return yield* new AgentHookBlockedError({ stage: input.stage, detail });
        }
        warnings.push(detail);
        yield* Effect.logWarning("Agent hook failed with warn policy", {
          profileId: input.profile.id,
          stage: input.stage,
          detail,
        });
      }
      return { context, warnings };
    },
  );

  return AgentHookRunner.of({ run });
});

export const layer = Layer.effect(AgentHookRunner, make);
