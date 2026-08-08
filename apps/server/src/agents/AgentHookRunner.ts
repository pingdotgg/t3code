import { AgentHookStage, type AgentHook, type AgentProfileDocument } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;

export class AgentHookBlockedError extends Schema.TaggedErrorClass<AgentHookBlockedError>()(
  "AgentHookBlockedError",
  {
    stage: AgentHookStage,
    hookKind: Schema.Literals(["context", "shell"]),
    category: Schema.Literals(["configuration", "filesystem", "process", "exit"]),
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Agent ${this.hookKind} hook failed during ${this.stage}: ${this.detail}`;
  }
}

class AgentHookExecutionError extends Schema.TaggedErrorClass<AgentHookExecutionError>()(
  "AgentHookExecutionError",
  {
    stage: AgentHookStage,
    hookKind: Schema.Literals(["context", "shell"]),
    category: Schema.Literals(["configuration", "filesystem", "process", "exit"]),
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Agent ${this.hookKind} hook failed during ${this.stage}: ${this.detail}`;
  }
}

const isAgentHookExecutionError = Schema.is(AgentHookExecutionError);

const executionError =
  (stage: AgentHookStage, hookKind: AgentHook["kind"], category: "filesystem" | "process") =>
  (cause: unknown) =>
    new AgentHookExecutionError({
      stage,
      hookKind,
      category,
      detail:
        category === "filesystem"
          ? "Context hook filesystem operation failed."
          : "Shell hook process failed.",
      cause,
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

const sameFile = (opened: FileSystem.File.Info, current: FileSystem.File.Info): boolean =>
  opened.dev === current.dev &&
  Option.isSome(opened.ino) &&
  Option.isSome(current.ino) &&
  opened.ino.value === current.ino.value;

const decodeUtf8Prefix = (bytes: Uint8Array): string => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = bytes.length; end >= Math.max(0, bytes.length - 4); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // A UTF-8 code point is at most four bytes. Try the preceding boundary.
    }
  }
  return new TextDecoder().decode(bytes);
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
        .pipe(Effect.mapError(executionError(hook.stage, "shell", "process")));
      if (result.code !== 0) {
        const detail = `Hook exited with code ${result.code ?? "unknown"}.`;
        return yield* new AgentHookExecutionError({
          stage: hook.stage,
          hookKind: "shell",
          category: "exit",
          detail,
          ...(result.code === null ? {} : { exitCode: result.code }),
          cause: { stderr: result.stderr.slice(0, 4_000), timedOut: result.timedOut },
        });
      }
      return result.stdout.trim();
    }

    if (path.isAbsolute(hook.path)) {
      return yield* new AgentHookExecutionError({
        stage: hook.stage,
        hookKind: "context",
        category: "configuration",
        detail: "Context hook paths must be workspace-relative.",
      });
    }
    return yield* Effect.gen(function* () {
      const root = yield* fileSystem
        .realPath(workspaceRoot)
        .pipe(Effect.mapError(executionError(hook.stage, "context", "filesystem")));
      const requestedPath = path.resolve(root, hook.path);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          // Open first, then validate that the path still names the same object.
          // Reads stay bound to this handle if a workspace path changes later.
          const file = yield* fileSystem
            .open(requestedPath, { flag: "r" })
            .pipe(Effect.mapError(executionError(hook.stage, "context", "filesystem")));
          const opened = yield* file.stat.pipe(
            Effect.mapError(executionError(hook.stage, "context", "filesystem")),
          );
          const candidate = yield* fileSystem
            .realPath(requestedPath)
            .pipe(Effect.mapError(executionError(hook.stage, "context", "filesystem")));
          const current = yield* fileSystem
            .stat(candidate)
            .pipe(Effect.mapError(executionError(hook.stage, "context", "filesystem")));
          if (!isContained(path, root, candidate) || !sameFile(opened, current)) {
            return yield* new AgentHookExecutionError({
              stage: hook.stage,
              hookKind: "context",
              category: "filesystem",
              detail: "Context hook path changed or resolves outside the workspace.",
            });
          }
          const readLength = Math.min(Number(opened.size), MAX_HOOK_OUTPUT_BYTES + 1);
          const bytes = new Uint8Array(readLength);
          let offset = 0;
          while (offset < bytes.length) {
            const count = Number(
              yield* file
                .read(bytes.subarray(offset))
                .pipe(Effect.mapError(executionError(hook.stage, "context", "filesystem"))),
            );
            if (count === 0) break;
            offset += count;
          }
          const truncated = Number(opened.size) > MAX_HOOK_OUTPUT_BYTES;
          const visible = bytes.subarray(0, Math.min(offset, MAX_HOOK_OUTPUT_BYTES));
          const contents = truncated
            ? decodeUtf8Prefix(visible)
            : new TextDecoder().decode(visible);
          return truncated ? `${contents}\n[hook context truncated]` : contents;
        }),
      );
    }).pipe(
      Effect.timeout(`${hook.timeoutSeconds} seconds`),
      Effect.mapError((cause) =>
        isAgentHookExecutionError(cause)
          ? cause
          : new AgentHookExecutionError({
              stage: hook.stage,
              hookKind: "context",
              category: "filesystem",
              detail: `Context hook timed out after ${hook.timeoutSeconds} second${hook.timeoutSeconds === 1 ? "" : "s"}.`,
              cause,
            }),
      ),
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
          return yield* new AgentHookBlockedError({
            stage: input.stage,
            hookKind: result.failure.hookKind,
            category: result.failure.category,
            detail,
            ...(result.failure.exitCode === undefined ? {} : { exitCode: result.failure.exitCode }),
            cause: result.failure,
          });
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
