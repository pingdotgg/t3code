import { type GrokSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as NodeOS from "node:os";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

export const GROK_API_KEY_ENV = "XAI_API_KEY";
export const GROK_AUTH_JSON_RELATIVE_PATH = ".grok/auth.json";
export const GROK_UNAUTHENTICATED_MESSAGE =
  "Grok CLI is not authenticated. Run `grok login` in a terminal or set XAI_API_KEY in provider environment variables.";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: ["agent", "stdio"],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return hasGrokApiKeyInEnvironment(environment)
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export function resolveGrokAuthJsonPath(homeDirectory: string): string {
  const normalizedHome = homeDirectory.replace(/\/$/, "");
  return `${normalizedHome}/${GROK_AUTH_JSON_RELATIVE_PATH}`;
}

export function hasGrokApiKeyInEnvironment(environment: NodeJS.ProcessEnv | undefined): boolean {
  const apiKey = environment?.[GROK_API_KEY_ENV]?.trim();
  return apiKey !== undefined && apiKey.length > 0;
}

export function grokAuthJsonHasCredentials(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.refresh_token === "string" && record.refresh_token.trim().length > 0) {
        return true;
      }
      if (typeof record.key === "string" && record.key.trim().length > 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function probeGrokCliCredentialsWithServices(
  fileSystem: FileSystem.FileSystem,
  pathService: Path.Path,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (hasGrokApiKeyInEnvironment(environment)) {
      return true;
    }
    const resolvedHomeDirectory =
      homeDirectory ??
      (environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir());
    const authPath = pathService.join(resolvedHomeDirectory, GROK_AUTH_JSON_RELATIVE_PATH);
    const exists = yield* fileSystem.exists(authPath);
    if (!exists) {
      return false;
    }
    const content = yield* fileSystem.readFileString(authPath).pipe(Effect.orElseSucceed(() => ""));
    return grokAuthJsonHasCredentials(content);
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

export const probeGrokCliCredentials = Effect.fn("probeGrokCliCredentials")(function* (
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  return yield* probeGrokCliCredentialsWithServices(
    fileSystem,
    pathService,
    environment,
    homeDirectory,
  );
});

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(input.grokSettings, input.cwd, input.environment),
        authMethodId: resolveGrokAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
