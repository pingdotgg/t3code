import { TextGenerationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AcpRequestError } from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import type { AcpRegistryError } from "./AcpRegistrySupport.ts";

const COPILOT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 128_000;
const isTextGenerationError = Schema.is(TextGenerationError);
const isAcpRequestError = Schema.is(AcpRequestError);
const CopilotConfig = Schema.Record(Schema.String, Schema.Unknown);
const decodeCopilotConfig = Schema.decodeEffect(fromLenientJson(CopilotConfig));
const encodeCopilotConfig = Schema.encodeEffect(Schema.fromJsonString(CopilotConfig));

// Copilot CLI 1.0.107: an allowlist naming only an unknown tool leaves the model none
// (`--available-tools=` alone restricts nothing). Deny rules back that up if a tool appears.
// `--no-auto-update` is omitted: standalone installs would run their older bundled version.
const COPILOT_HELPER_ARGS = [
  "--acp",
  "--available-tools=t3_no_tools",
  "--deny-tool=shell",
  "--deny-tool=write",
  "--deny-tool=read",
  "--deny-tool=url",
  "--deny-tool=memory",
  "--no-custom-instructions",
  "--no-ask-user",
  "--disable-builtin-mcps",
  "--disallow-temp-dir",
  "--sync-session=off",
];

// config.json also holds hooks, MCP servers, plugins and permissions; copy only the sign-in.
const COPILOT_AUTH_CONFIG_KEYS = [
  "loggedInUsers",
  "lastLoggedInUser",
  "copilotTokens",
  "authTokens",
] as const;

// COPILOT_ALLOW_ALL=true auto-approves tools and trusts the working directory's hooks and MCP.
const STRIPPED_ENVIRONMENT = ["COPILOT_ALLOW_ALL", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"];

export interface CopilotTextGenerationOptions {
  /** The instance's process environment, which locates the user's Copilot home. */
  readonly environment: NodeJS.ProcessEnv;
  readonly authMethodId?: string;
  readonly resolveSpawn: (
    cwd: string,
  ) => Effect.Effect<AcpSessionRuntime.AcpSpawnInput, AcpRegistryError>;
}

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  options: CopilotTextGenerationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const userCopilotHome =
    options.environment.COPILOT_HOME?.trim() ||
    path.join(options.environment.HOME?.trim() || homeDirectory, ".copilot");

  const seedSignIn = Effect.fn("CopilotTextGeneration.seedSignIn")(function* (
    operation: TextGenerationOperations.Operation,
    copilotHome: string,
  ) {
    const source = path.join(userCopilotHome, "config.json");
    if (!(yield* fs.exists(source))) return;
    // Proceeding without a readable sign-in could silently use another account.
    const config = yield* fs.readFileString(source).pipe(
      Effect.flatMap(decodeCopilotConfig),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not read the GitHub Copilot sign-in state for text generation.",
            cause,
          }),
      ),
    );
    const signIn = Object.fromEntries(
      COPILOT_AUTH_CONFIG_KEYS.flatMap((key) => (key in config ? [[key, config[key]]] : [])),
    );
    yield* encodeCopilotConfig(signIn).pipe(
      Effect.orDie,
      Effect.flatMap((contents) =>
        fs.writeFileString(path.join(copilotHome, "config.json"), contents, { mode: 0o600 }),
      ),
    );
  });

  const runCopilotJson: TextGenerationOperations.Runner = Effect.fn(
    "CopilotTextGeneration.runCopilotJson",
  )(
    function* (input) {
      const { operation } = input;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copilot-text-" });
      // A throwaway home keeps helper sessions out of the user's history, and their hooks, MCP
      // servers, plugins and instructions out of the helper.
      const copilotHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copilot-text-home-" });
      yield* seedSignIn(operation, copilotHome);

      const resolved = yield* options.resolveSpawn(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Could not launch GitHub Copilot: ${cause.message}`,
              cause,
            }),
        ),
      );
      const env: NodeJS.ProcessEnv = { ...resolved.env, COPILOT_HOME: copilotHome };
      for (const name of STRIPPED_ENVIRONMENT) delete env[name];
      const model = input.modelSelection.model.trim();
      const runtimeContext = yield* Layer.build(
        AcpSessionRuntime.layer({
          // Fixed arguments: a local install's own arguments could add MCP servers or permissions.
          spawn: {
            ...resolved,
            args: [
              ...COPILOT_HELPER_ARGS,
              // Copilot advertises no ACP model option; saved options such as allow_all never apply.
              ...(model.length > 0 && model !== "default" ? [`--model=${model}`] : []),
            ],
            cwd,
            env,
            extendEnv: false,
          },
          cwd,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "t3-code-text-generation", version: "0.0.0" },
          authenticateOnAuthRequired: false,
          ...(options.authMethodId ? { authMethodId: options.authMethodId } : {}),
          ownDetachedProcessGroup: true,
          processGroupPlatform: platform,
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, random),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(runtimeContext),
      );
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );

      const output = yield* Ref.make("");
      const rejected = yield* Deferred.make<never, TextGenerationError>();
      const reject = (detail: string) =>
        Deferred.fail(rejected, new TextGenerationError({ operation, detail })).pipe(Effect.asVoid);
      // Tool requests are tripwires: native tool removal is the boundary, since a report can
      // arrive after a tool ran.
      const rejectClientRequest = () =>
        reject("Copilot requested a client tool during text generation.").pipe(
          Effect.andThen(
            Effect.fail(
              new AcpRequestError({
                code: -32601,
                errorMessage: "Tools are disabled for text generation.",
              }),
            ),
          ),
        );
      yield* runtime.handleRequestPermission(() =>
        reject("Copilot requested a tool permission during text generation.").pipe(
          Effect.as({ outcome: { outcome: "cancelled" as const } }),
        ),
      );
      yield* runtime.handleElicitation(() =>
        reject("Copilot requested user input during text generation.").pipe(
          Effect.as({ action: "decline" as const }),
        ),
      );
      yield* runtime.handleReadTextFile(rejectClientRequest);
      yield* runtime.handleWriteTextFile(rejectClientRequest);
      yield* runtime.handleCreateTerminal(rejectClientRequest);
      yield* runtime.handleUnknownExtRequest(rejectClientRequest);
      yield* runtime.handleSessionUpdate(({ update }) =>
        Effect.gen(function* () {
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            return yield* reject("Copilot attempted tool work during text generation.");
          }
          if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
            return;
          }
          const text = update.content.text;
          const exceeded = yield* Ref.modify(output, (current) =>
            current.length + text.length > MAX_OUTPUT_CHARS
              ? [true, current]
              : [false, current + text],
          );
          if (exceeded) {
            return yield* reject("Copilot text generation exceeded the output limit.");
          }
        }),
      );

      const rawResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        const result = yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
        if (yield* Deferred.isDone(rejected)) return yield* Deferred.await(rejected);
        if (result.stopReason === "cancelled") {
          return yield* new TextGenerationError({
            operation,
            detail: "Copilot text generation was cancelled.",
          });
        }
        return (yield* Ref.get(output)).trim();
      }).pipe(
        Effect.onInterrupt(() => runtime.cancel.pipe(Effect.timeoutOption(2_000), Effect.ignore)),
        Effect.raceFirst(Deferred.await(rejected)),
      );
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail: "Copilot returned empty text generation output.",
        });
      }
      // Copilot streams notices such as "Info: Disabled tools: ..." before the reply.
      return yield* TextGenerationOperations.decodeJsonReply(input, "Copilot", rawResult);
    },
    (effect, input) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: COPILOT_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Copilot text generation timed out.",
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail:
                  isAcpRequestError(cause) && cause.code === -32000
                    ? "Sign in to GitHub Copilot in provider settings."
                    : "Copilot text generation failed.",
                cause,
              }),
        ),
      ),
  );

  return TextGenerationOperations.fromRunner(
    "CopilotTextGeneration",
    TextGenerationOperations.withoutInvestigation("Copilot", runCopilotJson),
  );
});
