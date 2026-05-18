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

function dirnameForExecutablePath(value: string | undefined): string | null {
  if (!value || !value.startsWith("/")) {
    return null;
  }
  const separatorIndex = value.lastIndexOf("/");
  return separatorIndex > 0 ? value.slice(0, separatorIndex) : "/";
}

function prependUniquePathEntries(
  currentPath: string | undefined,
  entries: ReadonlyArray<string | null>,
): string {
  const seen = new Set<string>();
  const next: Array<string> = [];
  for (const entry of [...entries, ...(currentPath ? currentPath.split(PATH_DELIMITER) : [])]) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    next.push(entry);
  }
  return next.join(PATH_DELIMITER);
}

function buildPiAcpEnvironment(
  piSettings: PiAcpRuntimePiSettings | null | undefined,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (!piSettings?.piBinaryPath && !piSettings?.binaryPath && !environment) {
    return undefined;
  }

  const env = { ...environment };
  if (piSettings?.piBinaryPath) {
    env.PI_ACP_PI_COMMAND = piSettings.piBinaryPath;
  }
  env.PATH = prependUniquePathEntries(env.PATH, [
    dirnameForExecutablePath(piSettings?.binaryPath),
    dirnameForExecutablePath(piSettings?.piBinaryPath),
  ]);
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
