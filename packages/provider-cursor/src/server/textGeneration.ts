import * as FileSystem from "effect/FileSystem";

import type { AgentOptions, RunResult } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ProviderSetupError, TextGenerationError } from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { cursorSdkModelSelection } from "./sdkModel.ts";
import type { CursorAuth } from "./auth.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CURSOR_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

function cursorSdkResultDetail(result: RunResult): string {
  switch (result.status) {
    case "cancelled":
      return "Cursor SDK request was cancelled.";
    case "error":
      return CursorAgentSdk.isCursorUsageLimitError(result.error)
        ? "Cursor usage limit reached. Try again later or choose another text-generation provider."
        : "Cursor SDK request finished with an error.";
    case "finished":
      return "Cursor SDK returned empty output.";
  }
}

// Sandboxing fails without cursorsandbox or after a process-wide unsupported result.
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

export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
  resolveApiKey?: Effect.Effect<string, ProviderSetupError>,
  withAccess?: CursorAuth["withAccess"],
) {
  const fs = yield* FileSystem.FileSystem;
  const sdk = yield* CursorSdk.CursorSdk;
  const resolvedEnvironment = environment ?? process.env;

  const resolveCursorApiKey = Effect.fn("CursorTextGeneration.resolveCursorApiKey")(function* (
    operation: TextGenerationOperations.Operation,
  ) {
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

  const runCursorJson: TextGenerationOperations.Runner = Effect.fn(
    "CursorTextGeneration.runCursorJson",
  )(
    function* (input) {
      const { operation, prompt, modelSelection } = input;

      const apiKey = yield* resolveCursorApiKey(operation);
      const sdkFailure = (detail: string) => (cause: unknown) =>
        new TextGenerationError({ operation, detail, cause });
      const { Agent } = yield* Effect.try({
        try: sdk.load,
        catch: sdkFailure("Cursor SDK could not be loaded."),
      });
      // sandbox.json expands writable paths independently of settingSources; the public API cannot override it.
      if (yield* fs.exists(`${yield* HostProcess.HomeDirectory}/.cursor/sandbox.json`)) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "Cursor text generation cannot enforce workspace isolation with a custom ~/.cursor/sandbox.json. Use another text-generation provider.",
        });
      }
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-text-" });
      // Only store disposal releases SDK SQLite handles; keep state outside the empty workspace.
      const stateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-text-state-" });
      const store = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => sdk.loadSqlite().SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot }),
          catch: sdkFailure("Cursor SDK agent store could not be opened."),
        }),
        (store) =>
          Effect.tryPromise({
            try: () => store.dispose(),
            catch: sdkFailure("Cursor SDK agent store could not be disposed."),
          }).pipe(Effect.ignore({ log: true })),
      );
      const agentOptions = {
        apiKey,
        mode: "plan",
        model: cursorSdkModelSelection(modelSelection),
        local: {
          cwd,
          store,
          autoReview: false,
          sandboxOptions: { enabled: true },
          settingSources: [],
          enableAgentRetries: true,
        },
      } satisfies AgentOptions;
      const createCursorAgent = (sandboxEnabled: boolean) =>
        Effect.tryPromise({
          try: (signal) =>
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
          catch: sdkFailure("Cursor SDK agent could not be created."),
        });

      const request = Effect.gen(function* () {
        // Empty cwd and setting sources isolate the run from user projects even if sandboxing fails.
        const agent = yield* Effect.acquireRelease(
          createCursorAgent(true).pipe(
            Effect.catchIf(cursorSandboxUnsupported, () => createCursorAgent(false)),
          ),
          (agent) =>
            Effect.tryPromise({
              try: () => agent[Symbol.asyncDispose](),
              catch: sdkFailure("Cursor SDK agent could not be disposed."),
            }).pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true })),
          { interruptible: true },
        );
        const run = yield* Effect.tryPromise({
          try: (signal) =>
            agent.send(prompt).then((run) => {
              if (signal.aborted) void run.cancel().catch(() => undefined);
              return run;
            }),
          catch: sdkFailure("Cursor SDK request could not be sent."),
        });
        yield* Effect.addFinalizer(() =>
          run.status === "running"
            ? Effect.tryPromise({
                try: () => run.cancel(),
                catch: sdkFailure("Cursor SDK run could not be cancelled."),
              }).pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true }))
            : Effect.void,
        );
        const promptResult = yield* Effect.tryPromise({
          try: () => run.wait(),
          catch: sdkFailure("Cursor SDK run failed."),
        });
        const rawResult = promptResult.result?.trim() ?? "";
        if (promptResult.status !== "finished" || !rawResult) {
          return yield* new TextGenerationError({
            operation,
            detail: cursorSdkResultDetail(promptResult),
            ...(promptResult.error ? { cause: promptResult.error } : {}),
          });
        }

        return yield* TextGenerationOperations.decodeJsonReply(input, "Cursor SDK", rawResult);
      }).pipe(
        Effect.scoped,
        Effect.retry({
          times: 1,
          while: (cause) => isTextGenerationError(cause) && Schema.isSchemaError(cause.cause),
        }),
      );
      return yield* request.pipe(
        Effect.timeoutOrElse({
          duration: CURSOR_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Cursor SDK request timed out.",
              }),
            ),
        }),
      );
    },
    (effect, input) => {
      const { operation } = input;
      return effect.pipe(
        Effect.scoped,
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
    },
  );

  return TextGenerationOperations.fromRunner(
    "CursorTextGeneration",
    TextGenerationOperations.withoutInvestigation("Cursor", runCursorJson),
  );
});
