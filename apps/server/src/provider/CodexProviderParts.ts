import { pipe } from "effect/Function";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type {
  CodexSettings,
  CustomModelSetting,
  ServerProvider,
  ServerProviderState,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { PREFERRED_DEFAULT_CODEX_MODELS, ServerSettingsError } from "@t3tools/contracts";

import {
  codexModelFamily,
  createModelCapabilities,
  formatCodexModelName,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  type CodexRateLimitSnapshot,
  type CodexResetCreditsSummary,
} from "./codexUsageLimits.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import packageJson from "../../package.json" with { type: "json" };
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);
const RATE_LIMITS_PROBE_TIMEOUT_MS = 3_000;

type CodexRateLimitsProbe =
  | {
      readonly snapshot: CodexRateLimitSnapshot;
      readonly rateLimitsByLimitId?:
        | Readonly<Record<string, CodexRateLimitSnapshot>>
        | null
        | undefined;
      readonly resetCredits: CodexResetCreditsSummary | null | undefined;
      readonly accountId?: string | null | undefined;
    }
  | { readonly failure: string };

const CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER = "2 seconds" as const;
const CODEX_CATALOG_REFRESH_TIMEOUT_MS = 3_000;
const CODEX_CONFIG_PROBE_TIMEOUT_MS = 3_000;
const CODEX_CATALOG_REFRESH_POLL = "100 millis" as const;
const CODEX_CLIENT_NAME = "T3 Code";
import type { CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { CODEX_AUTH_PROBE_TIMEOUT_MS, CODEX_PRESENTATION, accountProbeStatus, appendCustomCodexModels, applyConfiguredCodexServiceTier, applyPreferredCodexDefaultModel, emptyCodexModelsFromSettings, makePendingCodexProvider, probeCodexAppServerProvider, probeCodexCliVersion } from "./CodexProvider.ts";

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  probe: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly launchArgs?: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly skipNativeUsage?: boolean;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
  > = probeCodexAppServerProvider,
  environment?: NodeJS.ProcessEnv,
  managedAuth?: ServerProvider["auth"],
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const emptyModels = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in T3 Code settings.",
      },
    });
  }

  const probeResult = yield* probe({
    binaryPath: codexSettings.binaryPath,
    homePath: codexSettings.homePath,
    launchArgs: resolveCodexLaunchArgs(codexSettings.launchArgs, resolvedEnvironment),
    cwd: process.cwd(),
    environment: resolvedEnvironment,
    ...(managedAuth ? { skipNativeUsage: true } : {}),
  }).pipe(
    // Process teardown can outlast the work budget without discarding a completed snapshot.
    Effect.timeoutOption(Duration.millis(CODEX_AUTH_PROBE_TIMEOUT_MS)),
    Effect.scoped,
    Effect.result,
  );

  if (Result.isFailure(probeResult)) {
    const error = probeResult.failure;
    const installed = !isCodexAppServerSpawnError(error);
    const version = installed
      ? yield* probeCodexCliVersion({
          binaryPath: codexSettings.binaryPath,
          homePath: codexSettings.homePath,
          cwd: process.cwd(),
          environment: resolvedEnvironment,
        })
      : null;
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: installed
          ? `Codex app-server provider probe failed: ${error.message}.`
          : `Could not start Codex CLI (\`${codexSettings.binaryPath}\`). Check Settings → Providers → Codex → Binary path on the server.` +
            (codexSettings.binaryPath === "codex"
              ? " Installing ChatGPT or Codex desktop may not add codex to PATH."
              : " Make sure the configured executable exists and can be run."),
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking Codex app-server provider status.",
      },
    });
  }

  const snapshot = probeResult.success.value;
  const accountStatus = managedAuth
    ? { status: "ready" as const, auth: managedAuth, message: undefined }
    : accountProbeStatus(snapshot);
  const usageLimits =
    snapshot.account.account?.type === "apiKey"
      ? makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" })
      : snapshot.rateLimits === undefined || "failure" in snapshot.rateLimits
        ? makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            ...(accountStatus.message ? { message: accountStatus.message } : {}),
            ...(snapshot.rateLimits ? { message: snapshot.rateLimits.failure } : {}),
          })
        : codexRateLimitsToLimits({
            snapshot: snapshot.rateLimits.snapshot,
            rateLimitsByLimitId: snapshot.rateLimits.rateLimitsByLimitId,
            resetCredits: snapshot.rateLimits.resetCredits,
            checkedAt,
          });

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: codexSettings.enabled,
    checkedAt,
    models: pipe(
      appendCustomCodexModels(snapshot.models ?? [], codexSettings.customModels),
      applyPreferredCodexDefaultModel,
      (models) => applyConfiguredCodexServiceTier(models, snapshot.serviceTier),
    ),
    skills: snapshot.skills,
    slashCommands: [
      COMPACT_SLASH_COMMAND,
      {
        name: "goal",
        description: "Set a goal Codex keeps working toward until it is done",
        input: { hint: "Objective, or pause, resume, clear" },
      },
      {
        name: "feedback",
        description: "Send this thread and Codex logs to OpenAI",
        input: { hint: "Describe the issue (optional)" },
      },
    ],
    probe: {
      installed: true,
      version: snapshot.version ?? null,
      status: snapshot.models === undefined ? "warning" : accountStatus.status,
      auth: accountStatus.auth,
      ...(accountStatus.message
        ? { message: accountStatus.message }
        : snapshot.models === undefined
          ? { message: "Codex did not return its model catalog in time." }
          : {}),
      ...(managedAuth ? {} : { usageLimits }),
    },
  });
});

export { makePendingCodexProvider };

