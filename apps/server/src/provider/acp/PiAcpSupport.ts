import { type PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type PiAcpRuntimePiSettings = Pick<PiSettings, "binaryPath" | "piBinaryPath">;
const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;

function pathDelimiterForEnvironment(environment?: NodeJS.ProcessEnv): string {
  const pathValue = environment?.PATH ?? environment?.Path ?? environment?.path;
  if (pathValue?.includes(";")) {
    return ";";
  }
  return PATH_DELIMITER;
}

function pathKeyForEnvironment(environment?: NodeJS.ProcessEnv): "PATH" | "Path" | "path" {
  if (environment && "Path" in environment) return "Path";
  if (environment && "path" in environment) return "path";
  return "PATH";
}

function dirnameForExecutablePath(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replaceAll("\\", "/");
  const isWindowsAbsolute = WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized);
  if (!normalized.startsWith("/") && !isWindowsAbsolute) {
    return null;
  }
  const separatorIndex = normalized.lastIndexOf("/");
  if (isWindowsAbsolute && separatorIndex === 2) {
    return value.slice(0, 3);
  }
  return separatorIndex > 0 ? value.slice(0, separatorIndex) : "/";
}

function prependUniquePathEntries(
  currentPath: string | undefined,
  entries: ReadonlyArray<string | null>,
  delimiter = PATH_DELIMITER,
): string {
  const seen = new Set<string>();
  const next: Array<string> = [];
  for (const entry of [...entries, ...(currentPath ? currentPath.split(delimiter) : [])]) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    next.push(entry);
  }
  return next.join(delimiter);
}

function buildPiAcpEnvironment(
  piSettings: PiAcpRuntimePiSettings | null | undefined,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (!piSettings?.piBinaryPath && !piSettings?.binaryPath && !environment) {
    return undefined;
  }

  const env = { ...environment };
  const pathKey = pathKeyForEnvironment(env);
  const pathDelimiter = pathDelimiterForEnvironment(env);
  if (piSettings?.piBinaryPath) {
    env.PI_ACP_PI_COMMAND = piSettings.piBinaryPath;
  }
  const nextPath = prependUniquePathEntries(
    env[pathKey],
    [
      dirnameForExecutablePath(piSettings?.binaryPath),
      dirnameForExecutablePath(piSettings?.piBinaryPath),
    ],
    pathDelimiter,
  );
  if (nextPath) {
    env[pathKey] = nextPath;
  }
  return env;
}

export interface PiAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly piSettings: PiAcpRuntimePiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildPiAcpSpawnInput(
  piSettings: PiAcpRuntimePiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const env = buildPiAcpEnvironment(piSettings, environment);

  return {
    command: piSettings?.binaryPath || "pi-acp",
    args: [],
    cwd,
    ...(env ? { env } : {}),
  };
}

export const makePiAcpRuntime = (
  input: PiAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPiAcpSpawnInput(input.piSettings, input.cwd, input.environment),
        authMethodId: "terminal_setup",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
