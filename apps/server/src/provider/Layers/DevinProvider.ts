import type {
  DevinSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildDevinGlobalArgs } from "../acp/DevinAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DEVIN_MODEL = "swe-1-7-medium";
const PROBE_TIMEOUT_MS = 30_000;

const DevinModelsResponse = Schema.Struct({
  families: Schema.Array(
    Schema.Struct({
      family_label: Schema.String,
      family_uid: Schema.String,
      slug: Schema.String,
      aliases: Schema.optional(Schema.Array(Schema.String)),
      variants: Schema.Array(
        Schema.Struct({
          model_uid: Schema.String,
          label: Schema.String,
          max_context_tokens: Schema.optional(Schema.Number),
          max_output_tokens: Schema.optional(Schema.Number),
          cost_tier: Schema.optional(Schema.String),
          cost_summary: Schema.optional(Schema.String),
          is_new: Schema.optional(Schema.Boolean),
          is_beta: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
});

const DevinSkillsResponse = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    triggers: Schema.optional(Schema.Array(Schema.String)),
    provider: Schema.optional(Schema.String),
    base_dir: Schema.String,
    display_name: Schema.optional(Schema.String),
    warnings: Schema.optional(Schema.Array(Schema.String)),
    errors: Schema.optional(Schema.Array(Schema.String)),
  }),
);

const decodeModels = Schema.decodeUnknownExit(Schema.fromJsonString(DevinModelsResponse));
const decodeSkills = Schema.decodeUnknownExit(Schema.fromJsonString(DevinSkillsResponse));

const BUILT_IN_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "login", description: "Log in to Devin." },
  { name: "logout", description: "Log out of Devin." },
  { name: "status", description: "Show Devin authentication and session status." },
  { name: "workspace", description: "Show or change the active workspace." },
  { name: "compact", description: "Compact the current conversation context." },
  { name: "context", description: "Inspect current context usage." },
  { name: "session-stats", description: "Show statistics for this Devin session." },
  { name: "bug", description: "Report a Devin CLI issue." },
  { name: "help", description: "Show available Devin commands." },
  { name: "accept-edits", description: "Use edit-accepting permission mode." },
  { name: "ask", description: "Use approval-required permission mode." },
  { name: "plan", description: "Plan without implementing changes." },
  { name: "bypass", description: "Use full-access permission mode." },
];

export function resolveDevinAcpModelId(model: string | null | undefined): string {
  return model?.trim() || DEFAULT_DEVIN_MODEL;
}

function fallbackModels(settings: DevinSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [
      {
        slug: DEFAULT_DEVIN_MODEL,
        name: "SWE 1.7 Medium",
        isCustom: false,
        isDefault: true,
        capabilities: EMPTY_CAPABILITIES,
      },
    ],
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export function parseDevinModels(raw: string): ReadonlyArray<ServerProviderModel> {
  const decoded = decodeModels(raw);
  if (Exit.isFailure(decoded)) {
    return [];
  }
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const family of decoded.value.families) {
    for (const variant of family.variants) {
      const slug = variant.model_uid.trim();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      // Variant labels already carry the family name ("Claude Fable 5 High").
      // No `subProvider`: the picker strips it from the display name, which
      // would leave only the effort qualifier ("High") as the row title.
      const label = variant.label.trim() || slug;
      models.push({
        slug,
        name: label,
        isCustom: false,
        ...(slug === DEFAULT_DEVIN_MODEL ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      });
    }
  }
  return models;
}

export function parseDevinSkills(raw: string): {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
} {
  const decoded = decodeSkills(raw);
  if (Exit.isFailure(decoded)) {
    return { skills: [], commands: [] };
  }
  const skills: Array<ServerProviderSkill> = [];
  const commands: Array<ServerProviderSlashCommand> = [];
  for (const skill of decoded.value) {
    const name = skill.name.trim();
    const path = skill.base_dir.trim();
    if (!name || !path) continue;
    const description = skill.description?.trim();
    const displayName = skill.display_name?.trim();
    const enabled = (skill.errors?.length ?? 0) === 0;
    skills.push({
      name,
      path,
      scope: "provider",
      enabled,
      ...(description ? { description, shortDescription: description } : {}),
      ...(displayName ? { displayName } : {}),
    });
    // A skill with errors is disabled, so it must not surface a slash command
    // the user could still select.
    if (enabled && skill.triggers?.includes("user")) {
      commands.push({
        name,
        ...(description ? { description } : {}),
      });
    }
  }
  return { skills, commands };
}

function dedupeCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return Array.from(new Map(commands.map((command) => [command.name, command])).values());
}

const runDevinCommand = Effect.fn("runDevinCommand")(function* (
  settings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "devin";
  const resolved = yield* resolveSpawnCommand(
    command,
    [...buildDevinGlobalArgs(settings), ...args],
    { env: environment },
  );
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      shell: resolved.shell,
    }),
  );
});

function successfulOutput(result: CommandResult | undefined): string {
  return result?.code === 0 ? result.stdout : "";
}

export function isDevinAuthenticatedOutput(output: string, exitCode: number): boolean {
  const normalized = output.toLowerCase();
  const explicitlyUnauthenticated =
    normalized.includes("not logged in") ||
    normalized.includes("not authenticated") ||
    normalized.includes("unauthenticated");
  return (
    exitCode === 0 &&
    !explicitlyUnauthenticated &&
    (normalized.includes("logged in") || normalized.includes("authenticated"))
  );
}

export function buildInitialDevinProviderSnapshot(
  settings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Devin CLI availability, authentication, models, and skills...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Devin is disabled in T3 Code settings.",
          },
    });
  });
}

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return yield* buildInitialDevinProviderSnapshot(settings);
  }

  const versionAttempt = yield* runDevinCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionAttempt)) {
    const missing = isCommandMissingCause(versionAttempt.failure);
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(settings),
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `Devin CLI command \`${settings.binaryPath || "devin"}\` was not found.`
          : "Failed to execute the Devin CLI health check.",
      },
    });
  }
  if (Option.isNone(versionAttempt.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(settings),
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI version check timed out.",
      },
    });
  }

  const versionResult = versionAttempt.success.value;
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(settings),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI version check exited with an error.",
      },
    });
  }

  const [authResult, modelsResult, skillsResult] = yield* Effect.all(
    [
      runDevinCommand(settings, ["auth", "status"], environment).pipe(
        Effect.timeoutOption(PROBE_TIMEOUT_MS),
        Effect.orElseSucceed(() => Option.none()),
      ),
      runDevinCommand(settings, ["models", "list", "--format", "json"], environment).pipe(
        Effect.timeoutOption(PROBE_TIMEOUT_MS),
        Effect.orElseSucceed(() => Option.none()),
      ),
      runDevinCommand(settings, ["skills", "list", "--json"], environment).pipe(
        Effect.timeoutOption(PROBE_TIMEOUT_MS),
        Effect.orElseSucceed(() => Option.none()),
      ),
    ],
    // Devin's local credential/config store is shared by these commands.
    // Serial probes avoid transient lock/contention failures that otherwise
    // make a healthy model catalog appear empty.
    { concurrency: 1 },
  );

  // A probe that failed to run or timed out says nothing about credentials:
  // report it as unknown instead of telling a signed-in user to log in again.
  const authStatus = Option.isNone(authResult)
    ? ("unknown" as const)
    : isDevinAuthenticatedOutput(
          `${authResult.value.stdout}\n${authResult.value.stderr}`,
          authResult.value.code,
        )
      ? ("authenticated" as const)
      : ("unauthenticated" as const);
  const authenticated = authStatus === "authenticated";
  const discoveredModels = parseDevinModels(
    Option.isSome(modelsResult) ? successfulOutput(modelsResult.value) : "",
  );
  const discoveredSkills = parseDevinSkills(
    Option.isSome(skillsResult) ? successfulOutput(skillsResult.value) : "",
  );
  const models = providerModelsFromSettings(
    discoveredModels.length > 0 ? discoveredModels : fallbackModels(settings),
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
  const warnings = [
    authStatus === "unknown" ? "The Devin authentication check did not complete." : undefined,
    discoveredModels.length === 0 ? "Model discovery was unavailable." : undefined,
    Option.isNone(skillsResult) || skillsResult.value.code !== 0
      ? "Skill discovery was unavailable."
      : undefined,
  ].filter((warning): warning is string => warning !== undefined);

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: dedupeCommands([...BUILT_IN_COMMANDS, ...discoveredSkills.commands]),
    skills: discoveredSkills.skills,
    probe: {
      installed: true,
      version,
      status: authenticated && warnings.length === 0 ? "ready" : "warning",
      auth: { status: authStatus },
      ...(authStatus === "unauthenticated"
        ? {
            message:
              "Devin CLI is installed but not signed in. Send a message to sign in from the browser, or run `devin auth login`.",
          }
        : warnings.length > 0
          ? { message: warnings.join(" ") }
          : {}),
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
