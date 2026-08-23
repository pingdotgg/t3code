import * as NodeOS from "node:os";
import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
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

const ANTIGRAVITY_PRESENTATION = {
  displayName: "Antigravity",
  showInteractionModeToggle: true,
} as const;

export const ANTIGRAVITY_EFFORT_CAPABILITIES_HIGH_MED_LOW: ModelCapabilities =
  createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
        ],
      }),
    ],
  });

export const ANTIGRAVITY_EFFORT_CAPABILITIES_HIGH_LOW: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "high", label: "High", isDefault: true },
      ],
    }),
  ],
});

export const ANTIGRAVITY_EFFORT_CAPABILITIES = ANTIGRAVITY_EFFORT_CAPABILITIES_HIGH_MED_LOW;

const VERSION_PROBE_TIMEOUT_MS = 4_000;

export const ANTIGRAVITY_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    isCustom: false,
    capabilities: ANTIGRAVITY_EFFORT_CAPABILITIES_HIGH_MED_LOW,
  },
  {
    slug: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    isCustom: false,
    capabilities: ANTIGRAVITY_EFFORT_CAPABILITIES_HIGH_MED_LOW,
  },
  {
    slug: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    isCustom: false,
    capabilities: ANTIGRAVITY_EFFORT_CAPABILITIES_HIGH_MED_LOW,
  },
  {
    slug: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    isCustom: false,
    capabilities: ANTIGRAVITY_EFFORT_CAPABILITIES_HIGH_LOW,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    isCustom: false,
    capabilities: null,
  },
];

export const ANTIGRAVITY_MODEL_MAP: Record<string, string> = {
  // Flash 3.7
  "gemini-3.7-flash-high": "Gemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium": "Gemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low": "Gemini 3.7 Flash (Low)",
  "gemini-3.7-flash": "Gemini 3.7 Flash (High)",
  // Flash 3.6
  "gemini-3.6-flash-high": "Gemini 3.6 Flash (High)",
  "gemini-3.6-flash-medium": "Gemini 3.6 Flash (Medium)",
  "gemini-3.6-flash-low": "Gemini 3.6 Flash (Low)",
  "gemini-3.6-flash": "Gemini 3.6 Flash (High)",
  // Flash 3.5
  "gemini-3.5-flash-high": "Gemini 3.5 Flash (High)",
  "gemini-3.5-flash-medium": "Gemini 3.5 Flash (Medium)",
  "gemini-3.5-flash-low": "Gemini 3.5 Flash (Low)",
  "gemini-3.5-flash": "Gemini 3.5 Flash (High)",
  // Pro 3.1
  "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
  "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
  "gemini-3.1-pro": "Gemini 3.1 Pro (High)",
  // Claude & GPT
  "claude-sonnet-4-6": "Claude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6": "Claude Opus 4.6 (Thinking)",
  "claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
  "gpt-oss-120b": "GPT-OSS 120B (Medium)",
  "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
  // Aliases
  flash: "Gemini 3.7 Flash (High)",
  pro: "Gemini 3.1 Pro (High)",
};

export function normalizeAntigravityModel(model?: string, effort?: string): string {
  if (!model) {
    return "Gemini 3.7 Flash (High)";
  }
  if (Object.values(ANTIGRAVITY_MODEL_MAP).includes(model)) {
    return model;
  }
  const lower = model.toLowerCase().trim();
  const normalizedEffort = effort?.toLowerCase().trim();
  if (normalizedEffort) {
    const combinedKey = `${lower.replace(/-(high|medium|low)$/, "")}-${normalizedEffort}`;
    if (ANTIGRAVITY_MODEL_MAP[combinedKey]) {
      return ANTIGRAVITY_MODEL_MAP[combinedKey];
    }
  }
  if (ANTIGRAVITY_MODEL_MAP[lower]) {
    return ANTIGRAVITY_MODEL_MAP[lower];
  }
  return model;
}

export function antigravityModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ANTIGRAVITY_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    customModels ?? [],
    ANTIGRAVITY_EFFORT_CAPABILITIES,
  );
}

export function buildInitialAntigravityProviderSnapshot(
  antigravitySettings: AntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = antigravityModelsFromSettings(antigravitySettings.customModels);

    if (!antigravitySettings.enabled) {
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

const runAntigravityVersionCommand = (
  antigravitySettings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = antigravitySettings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const GoogleAccountsFileSchema = Schema.fromJsonString(
  Schema.Struct({
    active: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
  }),
);

const OAuthCredsFileSchema = Schema.fromJsonString(
  Schema.Struct({
    access_token: Schema.optional(Schema.String),
    refresh_token: Schema.optional(Schema.String),
    id_token: Schema.optional(Schema.String),
  }),
);

const decodeGoogleAccounts = Schema.decodeOption(GoogleAccountsFileSchema);
const decodeOAuthCreds = Schema.decodeOption(OAuthCredsFileSchema);

export const probeAntigravityAuth = Effect.fn("probeAntigravityAuth")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homedir = NodeOS.homedir();

  const accountsPath = path.join(homedir, ".gemini", "google_accounts.json");
  const credsPath = path.join(homedir, ".gemini", "oauth_creds.json");

  const [rawAccounts, rawCreds] = yield* Effect.all([
    fileSystem.readFileString(accountsPath).pipe(Effect.orElseSucceed(() => "")),
    fileSystem.readFileString(credsPath).pipe(Effect.orElseSucceed(() => "")),
  ]);

  let activeEmail: string | undefined;
  if (rawAccounts) {
    const parsed = decodeGoogleAccounts(rawAccounts);
    if (Option.isSome(parsed)) {
      if (parsed.value.active && parsed.value.active.includes("@")) {
        activeEmail = parsed.value.active;
      } else if (parsed.value.email && parsed.value.email.includes("@")) {
        activeEmail = parsed.value.email;
      }
    }
  }

  let hasCreds = false;
  if (rawCreds) {
    const parsed = decodeOAuthCreds(rawCreds);
    if (Option.isSome(parsed)) {
      if (parsed.value.access_token || parsed.value.refresh_token || parsed.value.id_token) {
        hasCreds = true;
      }
    }
  }

  if (activeEmail || hasCreds) {
    return {
      status: "authenticated" as const,
      type: "google",
      ...(activeEmail ? { email: activeEmail } : {}),
      label: "Google Account",
    } satisfies ServerProviderAuth;
  }

  return {
    status: "unauthenticated" as const,
    type: "google",
    label: "Google Account",
  } satisfies ServerProviderAuth;
});

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    antigravitySettings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = antigravityModelsFromSettings(antigravitySettings.customModels);

    if (!antigravitySettings.enabled) {
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

    const versionResult = yield* runAntigravityVersionCommand(
      antigravitySettings,
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Antigravity CLI health check failed.", {
        errorTag: error._tag,
      });
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "warning",
          auth: { status: "unauthenticated", type: "google", label: "Google Account" },
          message: isCommandMissingCause(error)
            ? "Antigravity CLI (`agy`) is not installed or not on PATH.\nInstall via:\n  curl -fsSL https://antigravity.google/cli/install.sh | bash\n(or on Windows: irm https://antigravity.google/cli/install.ps1 | iex)"
            : "Failed to execute Antigravity CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models,
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
        stdoutLength: versionOutput.stdout.length,
        stderrLength: versionOutput.stderr.length,
      });
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Antigravity CLI is installed but failed to run.",
        },
      });
    }

    const auth = yield* probeAntigravityAuth().pipe(
      Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
      Effect.map((opt) =>
        Option.getOrElse(opt, () => ({
          status: "unknown" as const,
          type: "google",
          label: "Google Account",
        })),
      ),
      Effect.orElseSucceed(() => ({
        status: "unknown" as const,
        type: "google",
        label: "Google Account",
      })),
    );

    const isUnauth = auth.status === "unauthenticated";

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: antigravitySettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: isUnauth ? "warning" : "ready",
        auth,
        ...(isUnauth
          ? {
              message:
                "Antigravity is installed but not authenticated. Run `agy` in your terminal to sign in with your Google account.",
            }
          : {}),
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
