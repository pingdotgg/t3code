import * as FileSystem from "effect/FileSystem";

import type { AgentOptions, RunResult, SDKModel } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ProviderSetupError,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { cursorSdkModelSelection } from "./sdkModel.ts";
import type { CursorAuth } from "./auth.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CURSOR_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

const TEXT_GENERATION_STAGE_DETAIL: Readonly<Record<string, string>> = {
  "textGenerate.load": "Cursor SDK could not be loaded.",
  "textGenerate.store": "Cursor SDK agent store could not be opened.",
  "textGenerate.create": "Cursor SDK agent could not be created.",
  "textGenerate.dispose": "Cursor SDK agent could not be disposed.",
  "textGenerate.send": "Cursor SDK request could not be sent.",
  "textGenerate.cancel": "Cursor SDK run could not be cancelled.",
  "textGenerate.wait": "Cursor SDK run failed.",
};

function workerTextGenerationDetail(error: CursorAgentSdk.CursorAgentSdkRunnerError): string {
  return TEXT_GENERATION_STAGE_DETAIL[error.method] ?? "Cursor SDK text generation failed.";
}

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

const runCursorTextGenerationWithStore = <E>(input: {
  readonly Agent: ReturnType<CursorSdk.CursorSdk["Service"]["load"]>["Agent"];
  readonly store: NonNullable<NonNullable<AgentOptions["local"]>["store"]>;
  readonly prompt: string;
  readonly apiKey: string;
  readonly model: NonNullable<AgentOptions["model"]>;
  readonly cwd: string;
  readonly mapError: (step: "create" | "dispose" | "send" | "cancel" | "wait", cause: unknown) => E;
  readonly logDisposeErrors?: boolean;
}): Effect.Effect<RunResult, E> => {
  const agentOptions = {
    apiKey: input.apiKey,
    mode: "plan",
    model: input.model,
    local: {
      cwd: input.cwd,
      store: input.store,
      autoReview: false,
      sandboxOptions: { enabled: true },
      settingSources: [],
      enableAgentRetries: true,
    },
  } satisfies AgentOptions;

  const createCursorAgent = (sandboxEnabled: boolean) =>
    Effect.tryPromise({
      try: (signal) =>
        input.Agent.create(
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
      catch: (cause) => input.mapError("create", cause),
    });

  const runPrompt = Effect.fn("CursorTextGeneration.runPrompt")(function* (
    sandboxEnabled: boolean,
  ) {
    const agent = yield* Effect.acquireRelease(
      createCursorAgent(sandboxEnabled),
      (agent) =>
        Effect.tryPromise({
          try: () => agent[Symbol.asyncDispose](),
          catch: (cause) => input.mapError("dispose", cause),
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.ignore(input.logDisposeErrors ? { log: true } : undefined),
        ),
      { interruptible: true },
    );
    const run = yield* Effect.tryPromise({
      try: (signal) =>
        agent.send(input.prompt).then((started) => {
          if (signal.aborted) void started.cancel().catch(() => undefined);
          return started;
        }),
      catch: (cause) => input.mapError("send", cause),
    });
    yield* Effect.addFinalizer(() =>
      run.status === "running"
        ? Effect.tryPromise({
            try: () => run.cancel(),
            catch: (cause) => input.mapError("cancel", cause),
          }).pipe(
            Effect.timeout("5 seconds"),
            Effect.ignore(input.logDisposeErrors ? { log: true } : undefined),
          )
        : Effect.void,
    );
    return yield* Effect.tryPromise({
      try: () => run.wait(),
      catch: (cause) => input.mapError("wait", cause),
    });
  }, Effect.scoped);

  // The SDK may reject sandboxing in create or lazily in send. Empty cwd and setting
  // sources isolate the unsandboxed retry from user projects.
  return runPrompt(true).pipe(Effect.catchIf(cursorSandboxUnsupported, () => runPrompt(false)));
};

export const runCursorTextGenerationInProcess = Effect.fn("CursorTextGeneration.runInProcess")(
  function* (input: CursorAgentSdk.CursorAgentSdkTextGenerateInput) {
    const sdk = yield* CursorSdk.CursorSdk;
    const { Agent } = yield* Effect.try({
      try: sdk.load,
      catch: (cause) =>
        new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "textGenerate.load", cause }),
    });
    const store = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          sdk.loadSqlite().SqliteLocalAgentStore.open({
            workspaceRef: input.cwd,
            stateRoot: input.stateRoot,
          }),
        catch: (cause) =>
          new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "textGenerate.store", cause }),
      }),
      (opened) =>
        Effect.tryPromise({
          try: () => opened.dispose(),
          catch: () => undefined,
        }).pipe(Effect.ignore),
    );
    return yield* runCursorTextGenerationWithStore({
      Agent,
      store: Object.assign(store, { persistRunEvents: false }),
      prompt: input.prompt,
      apiKey: input.apiKey,
      model: input.model,
      cwd: input.cwd,
      mapError: (step, cause) =>
        new CursorAgentSdk.CursorAgentSdkRunnerError({ method: `textGenerate.${step}`, cause }),
    });
  },
  Effect.scoped,
);

export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
  resolveApiKey?: Effect.Effect<string, ProviderSetupError>,
  withAccess?: CursorAuth["withAccess"],
  getModels?: () => ReadonlyArray<ServerProviderModel>,
  getSdkModels?: () => ReadonlyArray<SDKModel>,
  sdkRunner?: CursorAgentSdk.CursorAgentSdkRunner["Service"],
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
      const resolvedModel = cursorSdkModelSelection(
        modelSelection,
        getModels?.() ?? [],
        getSdkModels?.() ?? [],
      );
      const runInWorker = sdkRunner?.textGenerate;
      const executePrompt: Effect.Effect<RunResult, TextGenerationError> =
        runInWorker !== undefined
          ? runInWorker({
              prompt,
              apiKey,
              model: resolvedModel,
              cwd,
              stateRoot,
            }).pipe(
              Effect.mapError((error) => sdkFailure(workerTextGenerationDetail(error))(error)),
            )
          : yield* Effect.gen(function* () {
              const { Agent } = yield* Effect.try({
                try: sdk.load,
                catch: sdkFailure("Cursor SDK could not be loaded."),
              });
              const store = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: () =>
                    sdk.loadSqlite().SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot }),
                  catch: sdkFailure("Cursor SDK agent store could not be opened."),
                }),
                (store) =>
                  Effect.tryPromise({
                    try: () => store.dispose(),
                    catch: sdkFailure("Cursor SDK agent store could not be disposed."),
                  }).pipe(Effect.ignore({ log: true })),
              );
              const textGenerationErrorDetail = {
                create: "Cursor SDK agent could not be created.",
                dispose: "Cursor SDK agent could not be disposed.",
                send: "Cursor SDK request could not be sent.",
                cancel: "Cursor SDK run could not be cancelled.",
                wait: "Cursor SDK run failed.",
              } as const;
              return runCursorTextGenerationWithStore({
                Agent,
                store: Object.assign(store, { persistRunEvents: false }),
                prompt,
                apiKey,
                model: resolvedModel,
                cwd,
                mapError: (step, cause) => sdkFailure(textGenerationErrorDetail[step])(cause),
                logDisposeErrors: true,
              });
            });
      const request = Effect.gen(function* () {
        const promptResult = yield* executePrompt;
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
