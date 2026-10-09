import * as FileSystem from "effect/FileSystem";

import type { AgentOptions, RunResult } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type ProviderSetupError, TextGenerationError } from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { cursorSdkModelSelection } from "./sdkModel.ts";
import type { CursorAuth } from "./auth.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CURSOR_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

function cursorSdkResultDetail(result: RunResult): string {
  switch (result.status) {
    case "cancelled":
      return "Cursor SDK request was cancelled.";
    case "error":
      return "Cursor SDK request finished with an error.";
    case "finished":
      return "Cursor SDK returned empty output.";
  }
}

/**
 * The SDK throws this when `sandboxOptions.enabled` is set and local sandboxing
 * is unavailable. That happens on hosts that cannot launch `cursorsandbox`, and
 * also after an unsandboxed run caches "unsupported" for the process.
 */
function cursorSandboxUnsupported(cause: unknown): boolean {
  const seen = new Set<object>();
  let current = cause;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.message.includes("sandboxing is not supported")) {
      return true;
    }
    current = Reflect.get(current, "cause");
  }
  return false;
}

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
  resolveApiKey?: Effect.Effect<string, ProviderSetupError>,
  withAccess?: CursorAuth["withAccess"],
) {
  const fs = yield* FileSystem.FileSystem;
  const { Agent } = yield* CursorSdk.CursorSdk;
  const resolvedEnvironment = environment ?? process.env;

  const resolveCursorApiKey = (operation: TextGenerationOperations.Operation) =>
    Effect.gen(function* () {
      if (!cursorSettings.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: "Cursor is disabled in T3 Code settings.",
        });
      }

      const apiKey = resolveApiKey
        ? yield* resolveApiKey
        : resolvedEnvironment.CURSOR_API_KEY?.trim();
      if (!apiKey) {
        return yield* new TextGenerationError({
          operation,
          detail: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
        });
      }

      return apiKey;
    });

  // Ignores `cwd`: the agent runs in an empty temp directory, away from the project.
  const runCursorJson: TextGenerationOperations.Runner = (input) => {
    const { operation, prompt, modelSelection } = input;
    return Effect.gen(function* () {
      const apiKey = yield* resolveCursorApiKey(operation);
      // The SDK loads sandbox.json independently of settingSources and lets it
      // expand the writable paths. Its public API cannot override that policy.
      if (yield* fs.exists(`${yield* HostProcess.HomeDirectory}/.cursor/sandbox.json`)) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "Cursor text generation cannot enforce workspace isolation with a custom ~/.cursor/sandbox.json. Use another text-generation provider.",
        });
      }
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-text-" });
      const agentOptions = {
        apiKey,
        mode: "plan",
        model: cursorSdkModelSelection(modelSelection),
        local: {
          cwd,
          autoReview: false,
          sandboxOptions: { enabled: true },
          settingSources: [],
          enableAgentRetries: true,
        },
      } satisfies AgentOptions;
      const createCursorAgent = (sandboxEnabled: boolean) =>
        Effect.tryPromise((signal) =>
          Agent.create(
            sandboxEnabled
              ? agentOptions
              : {
                  ...agentOptions,
                  local: {
                    ...agentOptions.local,
                    sandboxOptions: { enabled: false },
                  },
                },
          ).then((agent) => {
            if (signal.aborted) agent.close();
            return agent;
          }),
        );

      const request = Effect.gen(function* () {
        // Prefer the sandbox. When the SDK refuses it, the empty temp directory
        // and empty setting sources still keep this run off the user's project.
        const agent = yield* Effect.acquireRelease(
          createCursorAgent(true).pipe(
            Effect.catchIf(cursorSandboxUnsupported, () => createCursorAgent(false)),
          ),
          (agent) =>
            Effect.tryPromise(() => agent[Symbol.asyncDispose]()).pipe(
              Effect.timeout("5 seconds"),
              Effect.ignore({ log: true }),
            ),
          { interruptible: true },
        );
        const run = yield* Effect.tryPromise((signal) =>
          agent.send(prompt).then((run) => {
            if (signal.aborted) void run.cancel().catch(() => undefined);
            return run;
          }),
        );
        yield* Effect.addFinalizer(() =>
          run.status === "running"
            ? Effect.tryPromise(() => run.cancel()).pipe(
                Effect.timeout("5 seconds"),
                Effect.ignore({ log: true }),
              )
            : Effect.void,
        );
        return yield* Effect.tryPromise(() => run.wait());
      }).pipe(Effect.scoped);
      const promptResult = yield* request.pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor SDK request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const rawResult = promptResult.result?.trim() ?? "";
      if (promptResult.status !== "finished" || !rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail: cursorSdkResultDetail(promptResult),
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(input, "Cursor SDK", rawResult);
    }).pipe(
      (effect) => (withAccess ? withAccess(effect) : effect),
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Cursor SDK text generation failed.",
              cause,
            }),
      ),
    );
  };

  return TextGenerationOperations.fromRunner("CursorTextGeneration", runCursorJson);
});
