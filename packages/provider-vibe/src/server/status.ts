import {
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { VibeSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { AccountView, ConfigView } from "@t3tools/vibe-app-server/client";
import { DEFAULT_VIBE_MODEL, withVibeAppServerClient } from "./appServerSupport.ts";
import { accountViewToUsageLimits } from "./usageLimits.ts";

const VIBE_PRESENTATION = {
  displayName: "Vibe",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"] as const,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_VIBE_MODEL,
    name: "Mistral Medium 3.5",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const PROBE_TIMEOUT_MS = 30_000;

function authFromAccount(account: AccountView): ServerProviderAuth {
  switch (account.status) {
    case "ready":
      return {
        status: "authenticated",
        type: "vibe",
        label: account.plan?.title ?? account.plan?.name ?? "Vibe",
      };
    case "missing_key":
    case "unauthorized":
      return { status: "unauthenticated", type: "vibe", label: "Vibe" };
    default:
      return { status: "unknown" };
  }
}

/** Thinking levels advertised by a model become a select option descriptor, like Grok's effort picker. */
export function buildVibeCapabilities(model: {
  thinkingLevels?: ReadonlyArray<string> | undefined;
  thinking?: string | undefined;
}): ModelCapabilities {
  const levels = (model.thinkingLevels ?? []).filter((level) => level.trim().length > 0);
  if (levels.length === 0) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "thinking",
        label: "Thinking",
        options: levels.map((level) => ({
          value: level,
          label: level,
          ...(model.thinking === level ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

export function vibeModelsFromConfig(
  config: ConfigView,
  fallback: ReadonlyArray<ServerProviderModel> = FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  const entries = config.models ?? [];
  if (entries.length === 0) return [...fallback];
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of entries) {
    const slug = entry.alias?.trim() || entry.name.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: entry.displayName?.trim() || entry.name.trim() || slug,
      isCustom: false,
      ...(config.defaultModelAlias !== undefined && config.defaultModelAlias === slug
        ? { isDefault: true }
        : {}),
      capabilities: buildVibeCapabilities(entry),
    });
  }
  return models.length > 0 ? models : [...fallback];
}

export const buildInitialVibeProviderSnapshot = Effect.fn(
  "VibeStatus.buildInitialVibeProviderSnapshot",
)(function* (settings: VibeSettings) {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = providerModelsFromSettings(
    FALLBACK_MODELS,
    settings.customModels ?? [],
    EMPTY_CAPABILITIES,
  );
  return buildServerProvider({
    presentation: VIBE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe: settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Mistral Vibe availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Vibe is disabled in T3 Code settings.",
        },
  });
});

export interface VibeProbeResult {
  readonly version: string | null;
  readonly auth: ServerProviderAuth;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly defaultAgent: string | undefined;
  readonly installed: boolean;
  readonly message?: string;
}

/**
 * Probes a live `vibe-app-server`: starts an ephemeral session in `probeCwd`,
 * then reads the account (auth + budget limits) and the config (models).
 */
const probeVibeAppServer = Effect.fn("VibeStatus.probeVibeAppServer")(function* (
  settings: VibeSettings,
  environment: NodeJS.ProcessEnv,
  probeCwd: string,
): Effect.fn.Return<VibeProbeResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  // The timeout wraps the whole scoped probe, including initialize, so a stalled
  // app server cannot hold the refresh semaphore forever.
  return yield* Effect.scoped(
    withVibeAppServerClient(
      {
        settings,
        cwd: probeCwd,
        environment,
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      },
      (client, serverInfo) =>
        Effect.gen(function* () {
          const version = serverInfo.version;
          const started = yield* client.sessionStart({
            kind: "ephemeral",
            agentConfig: {
              cwd: probeCwd,
              headless: true,
              // Probes must not mutate the user's persisted workspace trust.
              trustWorkspace: false,
            },
          });
          const sessionId = started.state.session.id;
          const account = yield* client.accountRead(sessionId);
          const config = yield* client
            .configRead(sessionId)
            .pipe(Effect.orElseSucceed(() => ({}) as ConfigView));
          yield* client.sessionDelete(sessionId).pipe(Effect.ignore);
          return {
            version,
            auth: authFromAccount(account),
            usageLimits: accountViewToUsageLimits(account, checkedAt),
            models: vibeModelsFromConfig(config),
            defaultAgent: config.defaultAgent ?? undefined,
            installed: true,
          } satisfies VibeProbeResult;
        }),
    ),
  ).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.map((option) =>
      option._tag === "None"
        ? ({
            version: null,
            auth: { status: "unknown" },
            usageLimits: undefined,
            models: [...FALLBACK_MODELS],
            defaultAgent: undefined,
            installed: true,
            message: "Vibe app server timed out while probing.",
          } satisfies VibeProbeResult)
        : option.value,
    ),
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning("Vibe app server probe failed", { cause }), {
        version: null,
        auth: { status: "unknown" },
        usageLimits: undefined,
        models: [...FALLBACK_MODELS],
        defaultAgent: undefined,
        installed: false,
        message: "Vibe app server probe failed.",
      } satisfies VibeProbeResult),
    ),
  );
});

export const checkVibeProviderStatus = Effect.fn("VibeStatus.checkVibeProviderStatus")(function* (
  settings: VibeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  probeCwd: string = process.cwd(),
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings(
    FALLBACK_MODELS,
    settings.customModels ?? [],
    EMPTY_CAPABILITIES,
  );
  if (!settings.enabled) {
    return yield* buildInitialVibeProviderSnapshot(settings);
  }
  const probe = yield* probeVibeAppServer(settings, environment, probeCwd);
  const models =
    probe.models.length > 0
      ? providerModelsFromSettings(probe.models, settings.customModels ?? [], EMPTY_CAPABILITIES)
      : fallbackModels;
  const status = !probe.installed
    ? "error"
    : probe.auth.status === "authenticated"
      ? "ready"
      : "warning";
  return buildServerProvider({
    presentation: VIBE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: probe.installed,
      version: probe.version,
      status,
      auth: probe.auth,
      ...(probe.message ? { message: probe.message } : {}),
      ...(probe.usageLimits ? { usageLimits: probe.usageLimits } : {}),
    },
  });
});
