import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const GLM_ACP_AGENT_ID = "glm-acp-agent";

/**
 * glm-acp-agent's `authenticate` is a no-op and it opens sessions without a key, so sign-in
 * only proves something when the agent can find one: `Z_AI_API_KEY`, or the credentials file
 * `glm-acp-agent --setup` writes. Checks presence only; never reads the key.
 */
export const makeGlmApiKeyCheck = Effect.fn("GlmAcp.makeApiKeyCheck")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  return (environment: NodeJS.ProcessEnv) => {
    if (environment.Z_AI_API_KEY) return Effect.succeed(true);
    const configHome =
      environment.XDG_CONFIG_HOME || path.join(environment.HOME || homeDirectory, ".config");
    return fileSystem
      .exists(path.join(configHome, GLM_ACP_AGENT_ID, "credentials.json"))
      .pipe(Effect.orElseSucceed(() => false));
  };
});
