import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import {
  decodeJsonReply,
  fromRunner,
  type Request,
  withoutInvestigation,
} from "@t3tools/provider-core/server/textGenerationOperations";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";

import type { GitHubCopilotSettings } from "../settings.ts";
import { makeCopilotSdkClient } from "./copilotSdkRuntime.ts";

const PROVIDER = "GitHub Copilot";
const TIMEOUT_MS = 180_000;
// `TIMEOUT_MS` only covers the reply, so a stalled CLI handshake needs its own limit.
const STARTUP_TIMEOUT_MS = 30_000;

export function makeGitHubCopilotTextGeneration(input: {
  readonly settings: GitHubCopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly makeClient?: typeof makeCopilotSdkClient;
}): ProviderTextGeneration {
  const makeClient = input.makeClient ?? makeCopilotSdkClient;
  const run = Effect.fnUntraced(function* <S extends Schema.Top>(request: Request<S>) {
    const binary = input.settings.binaryPath || "copilot";
    const command = yield* resolveCommandPath(binary, { env: input.environment }).pipe(
      Effect.provideService(FileSystem.FileSystem, input.fileSystem),
      Effect.provideService(Path.Path, input.path),
    );
    if (command === null) {
      return yield* new TextGenerationError({
        operation: request.operation,
        detail: `${PROVIDER} CLI (${binary}) is not installed or not on PATH.`,
      });
    }
    const client = makeClient({ command, args: [], env: input.environment });
    const reply = yield* Effect.tryPromise({
      try: () =>
        client.generateText({
          cwd: request.cwd,
          model: request.modelSelection.model,
          prompt: request.prompt,
          timeoutMs: TIMEOUT_MS,
        }),
      catch: (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${PROVIDER} could not generate text.`,
          cause,
        }),
    }).pipe(
      // The SDK cannot cancel a pending call, so an abandoned one has to end the CLI itself.
      Effect.onInterrupt(() =>
        Effect.tryPromise({
          try: () => client.forceStop(),
          catch: (cause) =>
            new TextGenerationError({
              operation: request.operation,
              detail: `${PROVIDER} could not be stopped.`,
              cause,
            }),
        }).pipe(Effect.ignore),
      ),
      Effect.timeoutOrElse({
        duration: TIMEOUT_MS + STARTUP_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new TextGenerationError({
              operation: request.operation,
              detail: `${PROVIDER} did not respond in time.`,
            }),
          ),
      }),
    );
    return yield* decodeJsonReply(request, PROVIDER, reply);
  });
  return fromRunner("GitHubCopilotTextGeneration", withoutInvestigation(PROVIDER, run));
}
