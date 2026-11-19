// @effect-diagnostics effectFnOpportunity:off globalDate:off globalDateInEffect:off globalJsonInEffect:off runEffectInsideEffect:off nodeBuiltinImport:off - Thin wrapper over promise-based cores; spans come from withSpan, and wall-clock timestamps are user-facing state.
import {
  GameDevError,
  type GameAsset,
  type GameCheckpoint,
  type GameCheckpointDiff,
  type GameDevAssetImportResult,
  type GameDevCapture,
  type GameDevCommandResult,
  type GameDevForgeGuiTestResult,
  type GameDevInstallInput,
  type GameDevOpenProjectInput,
  type GameDevOpenProjectResult,
  type GameDevOverview,
  type GameDevSettingsPatch,
  type GameDevWorkspace,
  type GameInstallEvent,
  type GameInstallTarget,
  type GameProject,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { GameDevCore } from "./gameDevCore.ts";

const toError = (cause: unknown) =>
  new GameDevError({ message: cause instanceof Error ? cause.message : String(cause) });

/** Wraps the promise-based core so RPC handlers and MCP tools share one instance. */
const attempt = <A>(name: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: toError }).pipe(Effect.withSpan(`GameDevService.${name}`));

export class GameDevService extends Context.Service<
  GameDevService,
  {
    readonly core: GameDevCore;
    readonly overview: Effect.Effect<GameDevOverview, GameDevError>;
    readonly detectProjects: (root: string) => Effect.Effect<ReadonlyArray<GameProject>, GameDevError>;
    readonly install: (
      input: GameDevInstallInput,
      report: (event: GameInstallEvent) => void,
    ) => Effect.Effect<void, GameDevError>;
    readonly locate: (target: GameInstallTarget, path: string) => Effect.Effect<GameDevOverview, GameDevError>;
    readonly openProject: (input: GameDevOpenProjectInput) => Effect.Effect<GameDevOpenProjectResult, GameDevError>;
    readonly bindSession: (sessionId: string, projectRoot: string) => Effect.Effect<GameDevWorkspace, GameDevError>;
    readonly updateSettings: (patch: GameDevSettingsPatch) => Effect.Effect<GameDevOverview, GameDevError>;
    readonly workspace: (projectRoot: string) => Effect.Effect<GameDevWorkspace, GameDevError>;
    readonly userCommand: (input: {
      readonly sessionId: string;
      readonly operation: string;
      readonly args: Record<string, unknown>;
    }) => Effect.Effect<GameDevCommandResult, GameDevError>;
    readonly capture: (captureId: string) => Effect.Effect<GameDevCapture, GameDevError>;
    readonly resolveApproval: (approvalId: string, approve: boolean) => Effect.Effect<{ readonly resolved: boolean }, GameDevError>;
    readonly checkpointCreate: (input: { readonly projectRoot: string; readonly label: string; readonly paths?: ReadonlyArray<string> }) => Effect.Effect<GameCheckpoint, GameDevError>;
    readonly checkpointDiff: (projectRoot: string, checkpointId: string) => Effect.Effect<GameCheckpointDiff, GameDevError>;
    readonly checkpointRestore: (projectRoot: string, checkpointId: string) => Effect.Effect<GameCheckpointDiff, GameDevError>;
    readonly assets: (projectRoot: string) => Effect.Effect<ReadonlyArray<GameAsset>, GameDevError>;
    readonly assetPreview: (projectRoot: string, assetId: string, revision: number) => Effect.Effect<GameDevCapture, GameDevError>;
    readonly assetImport: (input: { readonly projectRoot: string; readonly assetId: string; readonly revision: number; readonly confirmReplace: boolean }) => Effect.Effect<GameDevAssetImportResult, GameDevError>;
    readonly setForgeGuiKey: (apiKey: string | null) => Effect.Effect<GameDevOverview, GameDevError>;
    readonly testForgeGui: Effect.Effect<GameDevForgeGuiTestResult, GameDevError>;
    /** Runs promise-based core work for agent tools with the same error mapping. */
    readonly run: <A>(name: string, work: (core: GameDevCore) => Promise<A>) => Effect.Effect<A, GameDevError>;
  }
>()("t3/gameDev/GameDevService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const env = yield* HostProcess.Environment;
  const decoder = new TextDecoder();
  const core = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        GameDevCore.start({
          baseDir: config.baseDir,
          stateDir: config.stateDir,
          platform,
          arch,
          env,
          now: () => new Date(),
          getSecret: (name) =>
            Effect.runPromise(
              secrets.get(name).pipe(
                Effect.map((value) => (Option.isSome(value) ? decoder.decode(value.value) : null)),
                Effect.orElseSucceed(() => null),
              ),
            ),
          setSecret: (name, value) =>
            Effect.runPromise(
              (value === null ? secrets.remove(name) : secrets.set(name, new TextEncoder().encode(value))).pipe(Effect.orDie),
            ),
        }),
      catch: toError,
    }),
    (started) => Effect.promise(() => started.stop()),
  );
  return GameDevService.of({
    core,
    overview: attempt("overview", () => core.overview()),
    detectProjects: (root) => attempt("detectProjects", () => core.detectProjects(root)),
    install: (input, report) => attempt("install", () => core.install(input, report)),
    locate: (target, path) => attempt("locate", () => core.locate(target, path)),
    openProject: (input) => attempt("openProject", () => core.openProject(input)),
    bindSession: (sessionId, projectRoot) => attempt("bindSession", () => core.bind(sessionId, projectRoot)),
    updateSettings: (patch) => attempt("updateSettings", () => core.updateSettings(patch)),
    workspace: (projectRoot) => attempt("workspace", () => core.workspace(projectRoot)),
    userCommand: (input) =>
      attempt("userCommand", () =>
        core.command({ sessionId: input.sessionId, projectRoot: null, operation: input.operation, args: input.args, actor: "user", threadId: null }),
      ),
    capture: (captureId) => attempt("capture", async () => core.capture(captureId)),
    resolveApproval: (approvalId, approve) => attempt("resolveApproval", async () => core.resolveApproval(approvalId, approve)),
    checkpointCreate: (input) => attempt("checkpointCreate", () => core.checkpointCreate({ ...input, createdBy: "user" })),
    checkpointDiff: (projectRoot, checkpointId) => attempt("checkpointDiff", () => core.checkpointDiff(projectRoot, checkpointId)),
    checkpointRestore: (projectRoot, checkpointId) =>
      attempt("checkpointRestore", () => core.checkpointRestore(projectRoot, checkpointId, "user", null)),
    assets: (projectRoot) => attempt("assets", () => core.listAssets(projectRoot)),
    assetPreview: (projectRoot, assetId, revision) => attempt("assetPreview", () => core.assetPreview(projectRoot, assetId, revision)),
    assetImport: (input) =>
      attempt("assetImport", async () => {
        const result = await core.assetImport({ ...input, actor: "user", threadId: null });
        return result.import === null
          ? {
              asset: result.asset,
              import: { revision: input.revision, engine: "unity" as const, at: new Date().toISOString(), location: "", status: "awaiting-approval" as const, checks: [] },
              replaceRequired: result.replaceRequired,
            }
          : { asset: result.asset, import: result.import, replaceRequired: result.replaceRequired };
      }),
    setForgeGuiKey: (apiKey) => attempt("setForgeGuiKey", () => core.setForgeGuiKey(apiKey)),
    testForgeGui: attempt("testForgeGui", () => core.testForgeGui()),
    run: (name, work) => attempt(name, () => work(core)),
  });
});

export const layer = Layer.effect(GameDevService, make);
