import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import type { EnvRecord } from "../launchEnvUtils.ts";
import { mergeResolvedLaunchEnv } from "../launchEnvUtils.ts";

export interface ResolveLaunchEnvInput {
  readonly projectRoot: string;
  readonly projectId: ProjectId | string;
  readonly threadId: string;
  readonly worktreePath?: string | null;
  readonly extraEnv?: EnvRecord;
}

export interface LaunchEnvShape {
  readonly resolve: (input: ResolveLaunchEnvInput) => Effect.Effect<Record<string, string>>;
}

export const makeResolveLaunchEnv = (t3Home: string): LaunchEnvShape["resolve"] =>
  Effect.fn("LaunchEnv.resolve")(function* (input) {
    return mergeResolvedLaunchEnv({
      t3Home,
      ...(input.extraEnv !== undefined ? { extraEnv: input.extraEnv } : {}),
      context: {
        projectRoot: input.projectRoot,
        projectId: String(input.projectId),
        threadId: input.threadId,
        ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
      },
    });
  });

export class LaunchEnv extends Context.Service<LaunchEnv, LaunchEnvShape>()(
  "t3/launchEnv/Services/LaunchEnv",
) {
  static readonly layerTest = (t3Home: string) =>
    Layer.succeed(LaunchEnv, {
      resolve: makeResolveLaunchEnv(t3Home),
    } satisfies LaunchEnvShape);
}

export const makeLaunchEnv = Effect.fn("makeLaunchEnv")(function* () {
  const serverConfig = yield* ServerConfig;

  return {
    resolve: makeResolveLaunchEnv(serverConfig.baseDir),
  } satisfies LaunchEnvShape;
});

export const LaunchEnvLive = Layer.effect(LaunchEnv, makeLaunchEnv());
