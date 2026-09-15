/**
 * Provider integration context — the ownership marker T3 Code stamps into the
 * environment of the subprocesses it starts for a conversation.
 *
 * Provider hooks (for example Codex `PostToolUse`) need to tell whether an
 * event belongs to a conversation T3 already manages, so they can hand the
 * event back to T3 instead of letting it materialize as a second, ghost
 * conversation card. The marker is descriptive only: it carries no cwd,
 * tokens, endpoints, native provider IDs, or prompts. Conversation card
 * identity is the environment ID plus the T3 thread ID; the configured
 * provider instance slug is included for routing diagnostics, not identity.
 *
 * The value is derived at the invocation boundary from the server's persisted
 * `environment-id` file. When that identity cannot be read, the reserved key
 * is omitted entirely, so a subprocess never claims guessed ownership.
 *
 * @module providerIntegrationContext
 */
import { EnvironmentId, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";

export const T3CODE_INTEGRATION_CONTEXT = "T3CODE_INTEGRATION_CONTEXT";

export type ProviderIntegrationContextRequest =
  | {
      readonly kind: "conversation";
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
    }
  | { readonly kind: "auxiliary" };

const readEnvironmentId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  return yield* fileSystem
    .readFileString(serverConfig.environmentIdPath)
    .pipe(Effect.orElseSucceed(() => ""))
    .pipe(Effect.map((value) => value.trim()));
});

/**
 * Return a copy of `baseEnvironment` with the derived T3 integration context.
 *
 * `undefined` is returned only when the caller passed no base environment,
 * no reserved marker is inherited, and the server identity is unavailable,
 * which preserves the original "inherit
 * the parent environment" behavior for the Codex app-server. Otherwise a copy
 * is always returned: the caller's object and `process.env` are never mutated.
 * Any inherited `T3CODE_INTEGRATION_CONTEXT` is stripped before the freshly
 * derived marker is added, and a missing/empty/unreadable identity file simply
 * yields the stripped environment without the reserved key.
 */
export const withProviderIntegrationContext = Effect.fn("withProviderIntegrationContext")(
  function* (
    baseEnvironment: NodeJS.ProcessEnv | undefined,
    request: ProviderIntegrationContextRequest,
  ): Effect.fn.Return<
    NodeJS.ProcessEnv | undefined,
    never,
    FileSystem.FileSystem | ServerConfig.ServerConfig
  > {
    const environmentIdRaw = yield* readEnvironmentId;
    if (
      baseEnvironment === undefined &&
      environmentIdRaw.length === 0 &&
      process.env[T3CODE_INTEGRATION_CONTEXT] === undefined
    ) {
      return undefined;
    }

    const environment: NodeJS.ProcessEnv = { ...(baseEnvironment ?? process.env) };
    delete environment[T3CODE_INTEGRATION_CONTEXT];
    if (environmentIdRaw.length === 0) {
      return environment;
    }

    const environmentId = EnvironmentId.make(environmentIdRaw);
    const context =
      request.kind === "conversation"
        ? {
            version: 1,
            kind: "conversation",
            environmentId,
            threadId: request.threadId,
            providerInstanceId: request.providerInstanceId,
          }
        : { version: 1, kind: "auxiliary", environmentId };
    // @effect-diagnostics-next-line preferSchemaOverJson:off - serialize the locally constructed, primitive-only environment marker.
    environment[T3CODE_INTEGRATION_CONTEXT] = JSON.stringify(context);
    return environment;
  },
);
