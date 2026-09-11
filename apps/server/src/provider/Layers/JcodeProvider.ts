import {
  type CustomModelSetting,
  type JcodeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { JCODE_DEFAULT_MODEL_SLUG } from "../acp/JcodeAcpSupport.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const JCODE_PRESENTATION = {
  displayName: "Jcode",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AUTH_PROBE_TIMEOUT_MS = 6_000;
const MODELS_PROBE_TIMEOUT_MS = 6_000;

/** Jcode's daemon advertises only model/models/effort over ACP
 * `available_commands_update`, but every TUI slash command is accepted as
 * prompt text in an ACP session too (verified live: `/models` and
 * `/swarm status` both run). This list mirrors jcode's TUI help (command
 * table in the binary), minus machine-maintenance and release tooling a
 * remote user would not invoke from a chat composer. */
const JCODE_BUILT_IN_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "model",
    description: "Switch the model for this session, or show the current model",
    input: { hint: "model id (optional)" },
  },
  {
    name: "models",
    description: "List models available from the active provider",
  },
  {
    name: "effort",
    description: "Set reasoning effort, or show the current effort",
    input: { hint: "none|minimal|low|medium|high|xhigh|max (optional)" },
  },
  {
    name: "fast",
    description: "Toggle fast/low-latency request mode",
    input: { hint: "on|off|status|default (optional)" },
  },
  {
    name: "plan",
    description: "Create a plan-only response as a plan card",
  },
  {
    name: "swarm",
    description: "Toggle the swarm feature for this session",
    input: { hint: "on|off|status (optional)" },
  },
  {
    name: "subagent",
    description: "Launch a subagent manually",
    input: { hint: "--type <kind> --model <name> <prompt>" },
  },
  {
    name: "subagent-model",
    description: "Show or change the subagent model policy",
    input: { hint: "inherit|<model> (optional)" },
  },
  {
    name: "autoreview",
    description: "Show or toggle automatic end-of-turn review",
    input: { hint: "on|off|status|now (optional)" },
  },
  {
    name: "autojudge",
    description: "Show or toggle automatic end-of-turn judging",
    input: { hint: "on|off|status|now (optional)" },
  },
  {
    name: "review",
    description: "Launch a one-shot headed review session",
  },
  {
    name: "judge",
    description: "Launch a one-shot headed judge session",
  },
  {
    name: "agent",
    description: "Ask a side question without derailing the current session",
    input: { hint: "question" },
  },
  {
    name: "git",
    description: "Show git status for the session working directory",
    input: { hint: "status (optional)" },
  },
  {
    name: "commit",
    description: "Make logical commits from current changes",
  },
  {
    name: "commit-push",
    description: "Make logical commits from current changes, then push",
  },
  {
    name: "triage",
    description: "Triage GitHub issues and autonomously fix the safe ones",
  },
  {
    name: "test",
    description: "Verify a claim, feature, or current changes with layered tests",
    input: { hint: "claim|feature|current changes (optional)" },
  },
  {
    name: "todos",
    description: "Show the session todo list as a card in the chat",
    input: { hint: "card|panel|pin|on|off|status (optional)" },
  },
  {
    name: "compact",
    description: "Compact the conversation context",
    input: { hint: "reactive|proactive|semantic (optional)" },
  },
  {
    name: "rewind",
    description: "Rewind the conversation to a previous message",
    input: { hint: "undo (optional)" },
  },
  {
    name: "poke",
    description: "Poke the model to resume incomplete todos",
    input: { hint: "on|off|status (optional)" },
  },
  {
    name: "interrupt",
    description: "Cancel the current prompt or operation",
  },
  {
    name: "improve",
    description: "Autonomously improve the repository until returns diminish",
    input: { hint: "plan|resume|status|stop (optional)" },
  },
  {
    name: "refactor",
    description: "Run a safe refactor loop",
    input: { hint: "plan|resume|status|stop (optional)" },
  },
  {
    name: "overnight",
    description: "Run a supervised overnight coordinator",
    input: { hint: "status|cancel|... (optional)" },
  },
  {
    name: "memory",
    description: "Toggle the memory feature for this session",
    input: { hint: "on|off|status (optional)" },
  },
  {
    name: "agent-context",
    description: "Show the full session context snapshot",
  },
  {
    name: "skills",
    description: "Show loaded skills and recommendations",
  },
  {
    name: "session-list",
    description: "Open the interactive session picker",
  },
  {
    name: "fork",
    description: "Fork the session into a new window",
    input: { hint: "prompt (optional)" },
  },
  {
    name: "transfer",
    description: "Compact context into a fresh handoff session",
  },
  {
    name: "rename",
    description: "Rename the current session",
    input: { hint: "name | --clear" },
  },
  {
    name: "usage",
    description: "Show connected provider usage limits",
  },
  {
    name: "config",
    description: "Show or edit configuration",
  },
  {
    name: "diff",
    description: "Cycle or set the diff display mode",
    input: { hint: "off|inline|full|pinned|file (optional)" },
  },
];

const JCODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: JCODE_DEFAULT_MODEL_SLUG,
    name: "Jcode Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function jcodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = JCODE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

const runJcodeCliCommand = (
  jcodeSettings: JcodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = jcodeSettings.binaryPath || "jcode";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

interface JcodeAuthStatus {
  readonly anyAvailable: boolean | null;
}

interface JcodeModelListEntry {
  readonly provider: string;
  readonly model: string;
  readonly method: string;
  readonly available: boolean;
}

interface JcodeModelList {
  readonly provider: string | null;
  readonly selectedModel: string | null;
  readonly models: ReadonlyArray<string>;
  readonly availableRoutes: ReadonlyArray<JcodeModelListEntry>;
}

/** Parses `jcode model list --json`. Unrecognized output yields an empty
 * listing so the probe keeps the fallback model set. */
export function parseJcodeModelList(json: string): JcodeModelList {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { models?: unknown }).models)
    ) {
      const record = parsed as {
        provider?: unknown;
        selected_model?: unknown;
        models?: unknown;
      };
      const rawModels = record.models as unknown[];
      return {
        provider: typeof record.provider === "string" ? record.provider : null,
        selectedModel: typeof record.selected_model === "string" ? record.selected_model : null,
        models: rawModels.filter(
          (model): model is string => typeof model === "string" && model.trim().length > 0,
        ),
        availableRoutes: Array.isArray((parsed as { routes?: unknown }).routes)
          ? ((parsed as { routes?: unknown }).routes as unknown[]).flatMap((route) => {
              if (typeof route !== "object" || route === null) return [];
              const entry = route as {
                model?: unknown;
                available?: unknown;
                provider?: unknown;
                method?: unknown;
              };
              return typeof entry.model === "string" &&
                entry.available === true &&
                typeof entry.provider === "string" &&
                typeof entry.method === "string"
                ? [
                    {
                      provider: entry.provider,
                      model: entry.model,
                      method: entry.method,
                      available: true,
                    } satisfies JcodeModelListEntry,
                  ]
                : [];
            })
          : [],
      };
    }
  } catch {
    // fall through
  }
  return {
    provider: null,
    selectedModel: null,
    models: [],
    availableRoutes: [],
  };
}

/** Names a CLI-listed model for the picker. Labels carry the source provider
 * because jcode routes every model through one binary. */
function jcodeDiscoveredModel(
  slug: string,
  input: {
    readonly provider?: string;
    readonly method?: string;
  },
): ServerProviderModel {
  return {
    slug,
    name: input.provider !== undefined ? `${slug} (${input.provider} · ${input.method})` : slug,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  };
}

/** Builds the picker list from `jcode model list --json`: available routes
 * first (labels carry their provider/method), then the remaining known
 * models. `"jcode-auto"` is already in the fallback list and always wins. */
function jcodeModelsFromCliList(cliList: JcodeModelList): ReadonlyArray<ServerProviderModel> {
  const routes = cliList.availableRoutes;
  const selected = cliList.selectedModel?.trim() || undefined;
  const availableByModel = new Map(routes.map((route) => [route.model, route]));
  const seen = new Set<string>();
  const discovered: ServerProviderModel[] = [];
  if (selected !== undefined && selected !== JCODE_DEFAULT_MODEL_SLUG) {
    const route = availableByModel.get(selected);
    const discoveredName = jcodeDiscoveredModel(selected, {
      ...(route !== undefined ? { provider: route.provider } : {}),
      ...(route !== undefined ? { method: route.method } : {}),
    }).name;
    discovered.push({
      slug: selected,
      name: discoveredName,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
      isDefault: true,
    });
    seen.add(selected);
  }
  for (const route of routes) {
    if (seen.has(route.model) || route.model === JCODE_DEFAULT_MODEL_SLUG) continue;
    seen.add(route.model);
    discovered.push(
      jcodeDiscoveredModel(route.model, {
        provider: route.provider,
        method: route.method,
      }),
    );
  }
  // Models the CLI knows about but has no available route for: listed after
  // available ones, still passable with `-m`.
  for (const model of cliList.models) {
    if (seen.has(model) || model === JCODE_DEFAULT_MODEL_SLUG) continue;
    seen.add(model);
    discovered.push(jcodeDiscoveredModel(model, {}));
  }
  return discovered;
}

/**
 * Parses `jcode auth status --json`. Unrecognized output decodes to
 * `{ anyAvailable: null }` so the probe reports "unknown" instead of guessing.
 */
export function parseJcodeAuthStatus(json: string): JcodeAuthStatus {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "any_available" in parsed &&
      typeof (parsed as { any_available: unknown }).any_available === "boolean"
    ) {
      return { anyAvailable: (parsed as { any_available: boolean }).any_available };
    }
  } catch {
    // fall through
  }
  return { anyAvailable: null };
}

export function buildInitialJcodeProviderSnapshot(
  jcodeSettings: JcodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = jcodeModelsFromSettings(jcodeSettings.customModels);

    if (!jcodeSettings.enabled) {
      return buildServerProvider({
        presentation: JCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        slashCommands: JCODE_BUILT_IN_SLASH_COMMANDS,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Jcode is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: JCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands: JCODE_BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Jcode CLI availability...",
      },
    });
  });
}

export const checkJcodeProviderStatus = Effect.fn("checkJcodeProviderStatus")(function* (
  jcodeSettings: JcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = jcodeModelsFromSettings(jcodeSettings.customModels);
  const draft = buildServerProvider;

  if (!jcodeSettings.enabled) {
    return draft({
      presentation: JCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      slashCommands: JCODE_BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Jcode is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runJcodeCliCommand(jcodeSettings, ["version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Jcode CLI health check failed.", {
      errorTag: error._tag,
    });
    return draft({
      presentation: JCODE_PRESENTATION,
      enabled: jcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: JCODE_BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        auth: { status: "unknown" },
        status: "error",
        message: isCommandMissingCause(error)
          ? "Jcode CLI (`jcode`) is not installed or not on PATH."
          : "Failed to execute Jcode CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return draft({
      presentation: JCODE_PRESENTATION,
      enabled: jcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: JCODE_BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: true,
        version: null,
        auth: { status: "unknown" },
        status: "error",
        message: "Jcode CLI is installed but timed out while running `jcode version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Jcode CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return draft({
      presentation: JCODE_PRESENTATION,
      enabled: jcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: JCODE_BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: true,
        auth: { status: "unknown" },
        version,
        status: "error",
        message: "Jcode CLI is installed but failed to run.",
      },
    });
  }

  // `jcode auth status --json` reports whether any provider credential is
  // available, without starting the agent or opening a login flow.
  const authResult = yield* runJcodeCliCommand(
    jcodeSettings,
    ["auth", "status", "--json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const authStatus =
    Result.isSuccess(authResult) &&
    Option.isSome(authResult.success) &&
    authResult.success.value.code === 0
      ? parseJcodeAuthStatus(
          `${authResult.success.value.stdout}\n${authResult.success.value.stderr}`,
        )
      : { anyAvailable: null };
  if (Result.isFailure(authResult)) {
    yield* Effect.logWarning("Jcode CLI auth probe failed.", {
      errorTag: authResult.failure._tag,
    });
  }

  const auth: ServerProviderAuth =
    authStatus.anyAvailable === true
      ? { status: "authenticated", type: "cached_token", label: "Jcode account" }
      : authStatus.anyAvailable === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  // `jcode model list --json` walks the daemon's model catalog and route
  // availability, which is what feeds the picker; a failed listing just keeps
  // the fallback ("jcode-auto") model set.
  const modelsResult = yield* runJcodeCliCommand(
    jcodeSettings,
    ["model", "list", "--json"],
    environment,
  ).pipe(Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS), Effect.result);
  const cliList =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? parseJcodeModelList(
          `${modelsResult.success.value.stdout}\n${modelsResult.success.value.stderr}`,
        )
      : { provider: null, selectedModel: null, models: [], availableRoutes: [] };
  if (Result.isFailure(modelsResult)) {
    yield* Effect.logWarning("Jcode CLI model listing failed.", {
      errorTag: modelsResult.failure._tag,
    });
  }
  const discoveredModels = jcodeModelsFromCliList(cliList);
  const models =
    discoveredModels.length > 0
      ? providerModelsFromSettings(
          [...JCODE_BUILT_IN_MODELS, ...discoveredModels],
          jcodeSettings.customModels ?? [],
          EMPTY_CAPABILITIES,
        )
      : fallbackModels;

  return buildServerProvider({
    presentation: JCODE_PRESENTATION,
    enabled: jcodeSettings.enabled,
    checkedAt,
    models,
    slashCommands: JCODE_BUILT_IN_SLASH_COMMANDS,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichJcodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Jcode version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
