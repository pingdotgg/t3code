/**
 * AntigravityProvider — health probe and model discovery for the Antigravity
 * CLI (`agy`).
 *
 * Model discovery calls `agy models` directly rather than starting an ACP
 * session as the Grok provider does: Antigravity has no agent protocol of its
 * own, so spinning up the bridge just to enumerate models would spawn a
 * print-mode process for no reason.
 *
 * @module AntigravityProvider
 */
import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parseAntigravityModelList } from "../acp/AntigravityAcpSupport.ts";
import { expandHomePath } from "../../pathExpansion.ts";

export type AntigravityPlanType =
  | "plus"
  | "pro"
  | "ultra"
  | "enterprise"
  | "business"
  | "consumer"
  | "free"
  | "api_key"
  | "unknown";

export function antigravityAccountAuthLabel(
  planType: AntigravityPlanType | string | undefined,
): string | undefined {
  if (!planType) return undefined;
  switch (planType) {
    case "plus":
      return "Google AI Plus Subscription";
    case "pro":
      return "Google AI Pro Subscription";
    case "ultra":
      return "Google AI Ultra Subscription";
    case "enterprise":
      return "Google AI Enterprise Subscription";
    case "business":
      return "Google AI Business Subscription";
    case "consumer":
      return "Google AI Pro Subscription";
    case "free":
      return "Google Free Account";
    case "api_key":
      return "Google Gemini API Key";
    default:
      return "Google Subscription";
  }
}

const checkAntigravityAccountAuth = (
  settings: AntigravitySettings,
): Effect.Effect<
  {
    readonly status: "authenticated" | "unauthenticated" | "unknown";
    readonly label?: string;
    readonly email?: string;
  },
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const targetDir =
      settings.appDataDir?.trim() || path.join(expandHomePath("~"), ".gemini", "antigravity-cli");
    const logDir = path.join(targetDir, "log");

    let discoveredEmail: string | undefined = undefined;
    let discoveredPlanType: AntigravityPlanType = "unknown";

    yield* Effect.catchTags(
      Effect.gen(function* () {
        const exists = yield* fs.exists(logDir);
        if (exists) {
          const files = yield* fs.readDirectory(logDir);
          const logFiles = files
            .filter((f) => f.startsWith("cli-") && f.endsWith(".log"))
            .map((f) => path.join(logDir, f));

          const statResults = yield* Effect.all(
            logFiles.map((file) =>
              Effect.map(fs.stat(file), (stat) => ({
                file,
                mtimeMs: Option.getOrElse(stat.mtime, () => new Date(0)).getTime(),
              })),
            ),
            { concurrency: "unbounded" },
          );

          const sortedFiles = statResults.sort((a, b) => b.mtimeMs - a.mtimeMs).map((r) => r.file);

          for (const logFile of sortedFiles.slice(0, 5)) {
            const content = yield* fs.readFileString(logFile);
            const authMatches = [
              ...content.matchAll(/applyAuthResult:\s*email=([^\s,]+),\s*authMethod=([^\s,]+)/g),
            ];
            const emailMatches = [
              ...content.matchAll(/authenticated successfully as ([^\s\n,]+)/g),
            ];
            const authMatch = authMatches.pop();
            const emailMatch = emailMatches.pop();

            let latestMatch:
              | { type: "auth"; match: RegExpMatchArray }
              | { type: "email"; match: RegExpMatchArray }
              | undefined;
            if (authMatch && emailMatch) {
              latestMatch =
                (authMatch.index ?? 0) > (emailMatch.index ?? 0)
                  ? { type: "auth", match: authMatch }
                  : { type: "email", match: emailMatch };
            } else if (authMatch) {
              latestMatch = { type: "auth", match: authMatch };
            } else if (emailMatch) {
              latestMatch = { type: "email", match: emailMatch };
            }

            if (latestMatch?.type === "auth") {
              discoveredEmail = latestMatch.match[1]!.trim();
              const rawMethod = latestMatch.match[2]!.trim().toLowerCase();
              if (rawMethod.includes("plus")) discoveredPlanType = "plus";
              else if (rawMethod.includes("ultra")) discoveredPlanType = "ultra";
              else if (rawMethod.includes("enterprise")) discoveredPlanType = "enterprise";
              else if (rawMethod.includes("business")) discoveredPlanType = "business";
              else if (rawMethod.includes("api_key") || rawMethod.includes("apikey"))
                discoveredPlanType = "api_key";
              else if (rawMethod.includes("consumer") || rawMethod.includes("pro"))
                discoveredPlanType = "pro";
              else discoveredPlanType = "consumer";
              break;
            } else if (latestMatch?.type === "email") {
              discoveredEmail = latestMatch.match[1]!.trim();
              discoveredPlanType = "pro";
              break;
            }
          }
        }
      }),
      {
        PlatformError: () => Effect.void,
      },
    );

    if (discoveredPlanType === "unknown") {
      const onboardingPath = path.join(targetDir, "cache", "onboarding.json");
      yield* Effect.catchTags(
        Effect.gen(function* () {
          const exists = yield* fs.exists(onboardingPath);
          if (exists) {
            const content = yield* fs.readFileString(onboardingPath);
            const parsed = yield* Effect.try({
              try: () => JSON.parse(content) as unknown,
              catch: (error) => ({ _tag: "ParseError" as const, error }),
            });
            if (typeof parsed === "object" && parsed !== null) {
              const obj = parsed as Record<string, unknown>;
              if (obj["enterpriseOnboardingComplete"] === true) {
                discoveredPlanType = "enterprise";
              } else if (
                obj["consumerOnboardingComplete"] === true ||
                obj["onboardingComplete"] === true
              ) {
                discoveredPlanType = "pro";
              }
            }
          }
        }),
        {
          PlatformError: () => Effect.void,
          ParseError: () => Effect.void,
        },
      );
    }

    const label = antigravityAccountAuthLabel(discoveredPlanType);

    return {
      status: "authenticated",
      ...(label ? { label } : {}),
      ...(discoveredEmail ? { email: discoveredEmail } : {}),
    };
  });

const ANTIGRAVITY_PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Beta",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Turn an Antigravity model slug into a display name.
 *
 * Slugs encode the reasoning tier as a trailing `-high` / `-medium` / `-low`,
 * which reads better as a parenthetical suffix when un-grouped.
 */
export function formatAntigravityModelName(slug: string): string {
  const tierMatch = /^(.*)-(high|medium|low)$/.exec(slug);
  const base = tierMatch?.[1] ?? slug;
  const initialisms: Record<string, string> = { gpt: "GPT", oss: "OSS", ai: "AI" };
  return base
    .split("-")
    .map((word) => {
      const lower = word.toLowerCase();
      if (initialisms[lower]) {
        return initialisms[lower];
      }
      return /^\d/.test(word) ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

/**
 * Group raw model slugs returned by `agy models` (e.g. `gemini-3.6-flash-high`, `gemini-3.6-flash-medium`)
 * into base models with dynamic reasoning effort options.
 */
export function groupAntigravityModels(
  rawSlugs: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const groups = new Map<string, { efforts: Set<string>; defaultSlug: string }>();

  for (const slug of rawSlugs) {
    const tierMatch = /^(.*)-(high|medium|low)$/.exec(slug);
    if (tierMatch) {
      const base = tierMatch[1]!;
      const effort = tierMatch[2]!;
      const existing = groups.get(base) ?? { efforts: new Set<string>(), defaultSlug: slug };
      existing.efforts.add(effort);
      if (effort === "high") {
        existing.defaultSlug = slug;
      }
      groups.set(base, existing);
    } else {
      groups.set(slug, { efforts: new Set<string>(), defaultSlug: slug });
    }
  }

  const result: ServerProviderModel[] = [];

  for (const [baseSlug, data] of groups.entries()) {
    const name = formatAntigravityModelName(baseSlug);
    const effortList = Array.from(data.efforts);

    let capabilities: ModelCapabilities = EMPTY_CAPABILITIES;
    if (effortList.length > 0) {
      const options = effortList.map((eff) => ({
        id: eff,
        label: eff.charAt(0).toUpperCase() + eff.slice(1),
        ...(eff === "high" || effortList.length === 1 ? { isDefault: true } : {}),
      }));
      const hasDefault = options.some((opt) => opt.isDefault);
      if (!hasDefault && options.length > 0) {
        (options[options.length - 1] as { isDefault?: boolean }).isDefault = true;
      }

      capabilities = createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options,
            ...(options.find((o) => o.isDefault)?.id
              ? { currentValue: options.find((o) => o.isDefault)!.id }
              : {}),
          },
        ],
      });
    }

    result.push({
      slug: data.defaultSlug,
      name,
      isCustom: false,
      capabilities,
    });
  }

  return result;
}

/**
 * Fallback list used before discovery completes or when `agy models` fails.
 */
const ANTIGRAVITY_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ],
          currentValue: "high",
        },
      ],
    }),
  },
];

function antigravityModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ANTIGRAVITY_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialAntigravityProviderSnapshot(
  settings: AntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = antigravityModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Antigravity CLI availability...",
      },
    });
  });
}

const runAgyCommand = (
  settings: AntigravitySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        // `agy` starts a language server and will not emit `models` output
        // until stdin closes. The default "pipe" leaves it open forever, so
        // the probe would hang and time out with an empty list.
        stdin: "ignore",
      }),
    );
  });

const discoverAntigravityModels = (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.map(runAgyCommand(settings, ["models"], environment), (output) =>
    output.code === 0 ? groupAntigravityModels(parseAntigravityModelList(output.stdout)) : [],
  );

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    settings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = antigravityModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runAgyCommand(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Antigravity CLI health check failed.", { errorTag: error._tag });
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Antigravity CLI (`agy`) is not installed or not on PATH."
            : "Failed to execute Antigravity CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Antigravity CLI is installed but timed out while running `agy --version`.",
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      yield* Effect.logWarning("Antigravity CLI version probe exited with a non-zero status.", {
        exitCode: versionOutput.code,
      });
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Antigravity CLI is installed but failed to run.",
        },
      });
    }

    const discoveryResult = yield* discoverAntigravityModels(settings, environment).pipe(
      Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
      Effect.result,
    );
    const discoveredModels =
      Result.isSuccess(discoveryResult) && Option.isSome(discoveryResult.success)
        ? discoveryResult.success.value
        : [];
    if (discoveredModels.length === 0) {
      // A CLI that runs but lists no models is almost always an unfinished
      // Google sign-in, which `agy models` reports by printing nothing.
      yield* Effect.logWarning("Antigravity model discovery returned no models.");
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unauthenticated" },
          message: "Antigravity CLI is installed but listed no models. Run `agy` to sign in.",
        },
      });
    }

    const auth = yield* checkAntigravityAccountAuth(settings);

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: antigravityModelsFromSettings(settings.customModels, discoveredModels),
      probe: {
        installed: true,
        version,
        status: "ready",
        auth,
      },
    });
  },
);

export const enrichAntigravitySnapshot = (input: {
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
      Effect.logWarning("Antigravity version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
