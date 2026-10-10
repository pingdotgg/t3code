import type {
  CustomModelSetting,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ProviderProbeResult,
  type ServerProviderPresentation,
} from "@t3tools/provider-core/server/snapshotProbe";

import type { CloudCli } from "./cli.ts";

/** The only model a cloud runtime offers: whatever the cloud runs for the account. */
const CLOUD_DEFAULT_MODEL = "cloud";

const CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: CLOUD_DEFAULT_MODEL,
    name: "Cloud",
    isCustom: false,
    isDefault: true,
    capabilities: CAPABILITIES,
  },
];

/**
 * Cloud agents run unattended in their own sandbox, so there is nothing for
 * T3 to approve: Full access is the honest mode. The plan toggle is hidden
 * because the cloud never returns a plan card.
 */
const presentation = (displayName: string): ServerProviderPresentation => ({
  displayName,
  badgeLabel: "Beta",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["full-access"],
  supportsConversationRollback: false,
});

export interface CloudStatusInput {
  readonly displayName: string;
  readonly enabled: boolean;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
}

const snapshot = (input: CloudStatusInput, probe: ProviderProbeResult) =>
  Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: presentation(input.displayName),
      enabled: input.enabled,
      checkedAt: DateTime.formatIso(now),
      models: providerModelsFromSettings(BUILT_IN_MODELS, input.customModels, CAPABILITIES),
      probe,
    }),
  );

export const pendingCloudProvider = (input: CloudStatusInput) =>
  snapshot(input, {
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: input.enabled
      ? `Checking ${input.displayName}...`
      : `${input.displayName} is disabled in T3 Code settings.`,
  });

export interface CloudAuthCheck {
  readonly args: ReadonlyArray<string>;
  /** Reads the CLI's sign-in report; `message` explains a sign-in the cloud cannot use. */
  readonly read: (output: {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
  }) => {
    readonly auth: ServerProviderAuth;
    readonly message?: string;
  };
}

/** Runs `--version` and the CLI's sign-in check. Neither starts a session or a task. */
export const checkCloudProvider = Effect.fnUntraced(function* (
  input: CloudStatusInput & {
    readonly cli: CloudCli;
    readonly cwd: string;
    readonly binaryName: string;
    readonly authCheck: CloudAuthCheck;
    /** A setup problem that keeps runs from starting, such as a missing environment. */
    readonly setupWarning?: string;
  },
) {
  if (!input.enabled) return yield* pendingCloudProvider(input);
  const version = yield* input
    .cli({ args: ["--version"], cwd: input.cwd })
    .pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.option, Effect.map(Option.flatten));
  if (Option.isNone(version) || version.value.code !== 0)
    return yield* snapshot(input, {
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `${input.displayName} needs the ${input.binaryName} CLI on this T3 server host.`,
    });
  const parsedVersion = parseGenericCliVersion(version.value.stdout);
  const signIn = yield* input
    .cli({ args: input.authCheck.args, cwd: input.cwd })
    .pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.option, Effect.map(Option.flatten));
  const auth = Option.isSome(signIn)
    ? input.authCheck.read(signIn.value)
    : { auth: { status: "unknown" as const } };
  const message = auth.message ?? input.setupWarning;
  return yield* snapshot(input, {
    installed: true,
    version: parsedVersion,
    status: auth.auth.status === "unauthenticated" ? "error" : message ? "warning" : "ready",
    auth: auth.auth,
    ...(message ? { message } : {}),
  });
});

export const codexCloudAuthCheck: CloudAuthCheck = {
  args: ["login", "status"],
  // Codex prints its sign-in report on stderr.
  read: ({ stdout, stderr, code }) =>
    code === 0 && /ChatGPT/i.test(`${stdout}\n${stderr}`)
      ? { auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT" } }
      : {
          auth: { status: "unauthenticated" },
          message: "Codex Cloud needs a ChatGPT sign-in. Run codex login on this T3 server host.",
        },
};

const ClaudeAuthStatus = Schema.fromJsonString(
  Schema.Struct({
    loggedIn: Schema.Boolean,
    authMethod: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
  }),
);
const decodeClaudeAuthStatus = Schema.decodeUnknownOption(ClaudeAuthStatus);

export const claudeCloudAuthCheck: CloudAuthCheck = {
  args: ["auth", "status"],
  read: ({ stdout }) => {
    const status = decodeClaudeAuthStatus(stdout.trim());
    if (Option.isSome(status) && status.value.loggedIn && status.value.authMethod === "claude.ai")
      return {
        auth: {
          status: "authenticated",
          type: "claude.ai",
          label: "Claude",
          ...(status.value.email ? { email: status.value.email } : {}),
        },
      };
    return {
      auth: { status: "unauthenticated" },
      message:
        "Claude Code Cloud needs a claude.ai sign-in. Run claude auth login on this T3 server host.",
    };
  },
};
