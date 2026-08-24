import type { ModelCapabilities, OhMyPiSettings, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeOhMyPiAcpRuntime } from "../acp/OhMyPiAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Oh My Pi",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_START_TIMEOUT_MS = 15_000;

/** T3 selects the OMP harness; OMP selects the underlying role/model. */
export const OH_MY_PI_MANAGED_MODEL = "omp-managed";

const MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: OH_MY_PI_MANAGED_MODEL,
    name: "Oh My Pi (managed)",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const snapshot = (input: {
  enabled: boolean;
  checkedAt: string;
  installed: boolean;
  version: string | null;
  status: "ready" | "warning" | "error";
  auth: "authenticated" | "unauthenticated" | "unknown";
  message?: string;
}): ServerProviderDraft =>
  buildServerProvider({
    presentation: PRESENTATION,
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: MODELS,
    probe: {
      installed: input.installed,
      version: input.version,
      status: input.status,
      auth: { status: input.auth },
      ...(input.message ? { message: input.message } : {}),
    },
  });

export function buildInitialOhMyPiProviderSnapshot(
  settings: OhMyPiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) => {
    const checkedAt = DateTime.formatIso(now);
    return settings.enabled
      ? snapshot({
          enabled: true,
          checkedAt,
          installed: true,
          version: null,
          status: "warning",
          auth: "unknown",
          message: "Checking Oh My Pi CLI availability...",
        })
      : snapshot({
          enabled: false,
          checkedAt,
          installed: false,
          version: null,
          status: "warning",
          auth: "unknown",
          message: "Oh My Pi is disabled in T3 Code settings.",
        });
  });
}

const runVersion = (settings: OhMyPiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "omp";
    const spawn = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
    );
  });

const verifyAcpStartup = (settings: OhMyPiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeOhMyPiAcpRuntime({
      ohMyPiSettings: settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* runtime.start();
  }).pipe(Effect.scoped);

export const checkOhMyPiProviderStatus = Effect.fn("checkOhMyPiProviderStatus")(function* (
  settings: OhMyPiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot({
      enabled: false,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      auth: "unknown",
      message: "Oh My Pi is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runVersion(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    return snapshot({
      enabled: true,
      checkedAt,
      installed: !isCommandMissingCause(versionResult.failure),
      version: null,
      status: "error",
      auth: "unknown",
      message: isCommandMissingCause(versionResult.failure)
        ? "Oh My Pi CLI (`omp`) is not installed or not on PATH."
        : "Failed to execute the Oh My Pi CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return snapshot({
      enabled: true,
      checkedAt,
      installed: true,
      version: null,
      status: "error",
      auth: "unknown",
      message: "Oh My Pi CLI timed out while running `omp --version`.",
    });
  }

  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0) {
    return snapshot({
      enabled: true,
      checkedAt,
      installed: true,
      version,
      status: "error",
      auth: "unknown",
      message: "Oh My Pi CLI is installed but failed to run.",
    });
  }

  const acpExit = yield* verifyAcpStartup(settings, environment).pipe(
    Effect.timeoutOption(ACP_START_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(acpExit)) {
    return snapshot({
      enabled: true,
      checkedAt,
      installed: true,
      version,
      status: "error",
      auth: "unknown",
      message: "Oh My Pi is installed but `omp acp` could not start. Check OMP authentication and server logs.",
    });
  }
  if (Option.isNone(acpExit.value)) {
    return snapshot({
      enabled: true,
      checkedAt,
      installed: true,
      version,
      status: "error",
      auth: "unknown",
      message: `Oh My Pi ACP startup timed out after ${ACP_START_TIMEOUT_MS}ms.`,
    });
  }

  return snapshot({
    enabled: true,
    checkedAt,
    installed: true,
    version,
    status: "ready",
    auth: "authenticated",
  });
});
