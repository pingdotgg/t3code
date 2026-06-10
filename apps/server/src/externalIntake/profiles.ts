import { ProviderInstanceId, type ModelSelection, type ProjectScript } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export interface IntakeSetupScriptProfile {
  readonly id?: string;
  readonly name?: string;
  readonly command: string;
  readonly icon?: ProjectScript["icon"];
}

export interface SupportEmailProfile {
  readonly to?: readonly string[];
  readonly productName?: string;
  readonly groupAddress?: string;
  readonly slackChannelId?: string;
  readonly triagePrompt?: string;
  readonly agentPrompt?: string;
}

export interface IntakeProjectProfile {
  readonly id: string;
  readonly title?: string;
  readonly workspaceRoot: string;
  readonly aliases: readonly string[];
  readonly slackEmoji?: string;
  readonly primary?: boolean;
  readonly defaultBaseRef?: string;
  readonly setupScript?: IntakeSetupScriptProfile;
  readonly modelSelection?: ModelSelection;
  readonly supportEmail?: SupportEmailProfile;
}

function envValue(name: string) {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function splitCsv(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? []
  );
}

function parseProfilesJson(): IntakeProjectProfile[] {
  const raw = envValue("T3_INTAKE_PROFILES_JSON");
  if (raw === undefined) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("T3_INTAKE_PROFILES_JSON must be a JSON array.");
  }
  return parsed.map((entry, index) => normalizeProfile(entry, `profile-${index + 1}`));
}

function normalizeStringRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Intake profile entries must be objects.");
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

function slackEmojiField(record: Record<string, unknown>): string | undefined {
  const value = stringField(record, "slackEmoji");
  if (value === undefined) return undefined;
  const normalized = value.replace(/^:/, "").replace(/:$/, "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function stringArrayField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Intake profile field ${field} must be an array of strings.`);
  }
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );
}

function setupScriptField(record: Record<string, unknown>): IntakeSetupScriptProfile | undefined {
  const value = record.setupScript;
  if (value === undefined) return undefined;
  const setup = normalizeStringRecord(value);
  const command = stringField(setup, "command");
  if (command === undefined) {
    throw new Error("Intake profile setupScript.command is required when setupScript is set.");
  }
  const id = stringField(setup, "id");
  const name = stringField(setup, "name");
  const icon = stringField(setup, "icon");
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    command,
    ...(icon !== undefined ? { icon: icon as ProjectScript["icon"] } : {}),
  };
}

function supportEmailField(record: Record<string, unknown>): SupportEmailProfile | undefined {
  const value = record.supportEmail;
  if (value === undefined) return undefined;
  const support = normalizeStringRecord(value);
  const productName = stringField(support, "productName");
  const groupAddress = stringField(support, "groupAddress");
  const slackChannelId = stringField(support, "slackChannelId");
  const triagePrompt = stringField(support, "triagePrompt");
  const agentPrompt = stringField(support, "agentPrompt");
  return {
    to: stringArrayField(support, "to"),
    ...(productName !== undefined ? { productName } : {}),
    ...(groupAddress !== undefined ? { groupAddress } : {}),
    ...(slackChannelId !== undefined ? { slackChannelId } : {}),
    ...(triagePrompt !== undefined ? { triagePrompt } : {}),
    ...(agentPrompt !== undefined ? { agentPrompt } : {}),
  };
}

function normalizeProfile(value: unknown, fallbackId: string): IntakeProjectProfile {
  const record = normalizeStringRecord(value);
  const workspaceRoot = stringField(record, "workspaceRoot");
  if (workspaceRoot === undefined) {
    throw new Error("Intake profile workspaceRoot is required.");
  }
  const id = stringField(record, "id") ?? fallbackId;
  const title = stringField(record, "title");
  const primary = booleanField(record, "primary");
  const defaultBaseRef = stringField(record, "defaultBaseRef");
  const slackEmoji = slackEmojiField(record);
  const setupScript = setupScriptField(record);
  const supportEmail = supportEmailField(record);
  const aliases = stringArrayField(record, "aliases");
  return {
    id,
    ...(title !== undefined ? { title } : {}),
    workspaceRoot: expandHomePath(workspaceRoot),
    aliases: aliases.length > 0 ? aliases : [id],
    ...(slackEmoji !== undefined ? { slackEmoji } : {}),
    ...(primary !== undefined ? { primary } : {}),
    ...(defaultBaseRef !== undefined ? { defaultBaseRef } : {}),
    ...(setupScript !== undefined ? { setupScript } : {}),
    ...(supportEmail !== undefined ? { supportEmail } : {}),
  };
}

function defaultModelSelectionFromEnv(): ModelSelection | undefined {
  const instanceId = envValue("T3_DEFAULT_PROVIDER_INSTANCE_ID");
  const model = envValue("T3_DEFAULT_MODEL");
  if (instanceId === undefined || model === undefined) {
    return undefined;
  }
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    model,
  };
}

function legacySupportEmailProfile(): IntakeProjectProfile | null {
  const workspaceRoot = envValue("SUPPORT_EMAIL_PROJECT_WORKSPACE_ROOT");
  const repoName = envValue("SUPPORT_EMAIL_REPO_NAME");
  if (workspaceRoot === undefined && repoName === undefined) {
    return null;
  }

  const id = envValue("SUPPORT_EMAIL_PROFILE_ID") ?? repoName ?? "support-email";
  const aliases = [
    id,
    ...(repoName !== undefined ? [repoName] : []),
    ...splitCsv(envValue("SUPPORT_EMAIL_PROJECT_ALIASES")),
  ];
  const setupCommand = envValue("SUPPORT_EMAIL_SETUP_COMMAND");
  const productName = envValue("SUPPORT_EMAIL_PRODUCT_NAME") ?? repoName;
  const groupAddress = envValue("SUPPORT_EMAIL_GROUP_ADDRESS");
  const slackChannelId = envValue("SUPPORT_EMAIL_SLACK_CHANNEL_ID");
  const triagePrompt = envValue("SUPPORT_EMAIL_TRIAGE_PROMPT");
  const agentPrompt = envValue("SUPPORT_EMAIL_AGENT_PROMPT");
  const defaultModelSelection = defaultModelSelectionFromEnv();
  return {
    id,
    title: repoName ?? id,
    workspaceRoot: expandHomePath(workspaceRoot ?? `~/code/${repoName ?? id}`),
    aliases,
    defaultBaseRef:
      envValue("SUPPORT_EMAIL_DEFAULT_BASE_REF") ??
      envValue("T3_INTAKE_DEFAULT_BASE_REF") ??
      "main",
    ...(setupCommand !== undefined
      ? {
          setupScript: {
            id: "support-email-setup",
            name: "Support email setup",
            command: setupCommand,
            icon: "configure",
          },
        }
      : {}),
    ...(defaultModelSelection !== undefined ? { modelSelection: defaultModelSelection } : {}),
    supportEmail: {
      to: splitCsv(envValue("SUPPORT_EMAIL_TO")),
      ...(productName !== undefined ? { productName } : {}),
      ...(groupAddress !== undefined ? { groupAddress } : {}),
      ...(slackChannelId !== undefined ? { slackChannelId } : {}),
      ...(triagePrompt !== undefined ? { triagePrompt } : {}),
      ...(agentPrompt !== undefined ? { agentPrompt } : {}),
    },
  };
}

export function loadIntakeProfiles(): IntakeProjectProfile[] {
  const profiles = parseProfilesJson();
  const legacySupport = legacySupportEmailProfile();
  return legacySupport === null ? profiles : [...profiles, legacySupport];
}

export function profileRoutingAliases(profile: IntakeProjectProfile): readonly string[] {
  return [
    ...profile.aliases,
    ...(profile.slackEmoji !== undefined ? [`:${profile.slackEmoji}:`] : []),
  ];
}

export function defaultIntakeProfile(
  profiles: readonly IntakeProjectProfile[],
): IntakeProjectProfile | undefined {
  const defaultProfileId = envValue("T3_INTAKE_DEFAULT_PROFILE_ID");
  if (defaultProfileId !== undefined) {
    const profile = profiles.find((candidate) => candidate.id === defaultProfileId);
    if (profile === undefined) {
      throw new Error(
        `T3_INTAKE_DEFAULT_PROFILE_ID="${defaultProfileId}" does not match a configured intake profile.`,
      );
    }
    return profile;
  }

  const primaryProfiles = profiles.filter((profile) => profile.primary === true);
  if (primaryProfiles.length > 1) {
    throw new Error("Only one intake profile can set primary: true.");
  }
  return primaryProfiles[0];
}

export function setupScriptToProjectScript(profile: IntakeProjectProfile): ProjectScript | null {
  const setupScript = profile.setupScript;
  if (setupScript === undefined) return null;
  return {
    id: setupScript.id ?? `${profile.id}-setup`,
    name: setupScript.name ?? "Worktree setup",
    command: setupScript.command,
    icon: setupScript.icon ?? "configure",
    runOnWorktreeCreate: true,
  };
}

export function defaultBaseRefForProfile(profile: IntakeProjectProfile | null): string {
  return profile?.defaultBaseRef ?? envValue("T3_INTAKE_DEFAULT_BASE_REF") ?? "main";
}
