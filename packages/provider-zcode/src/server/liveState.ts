import type {
  ProviderOptionDescriptor,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpSchema from "effect-acp/compat";

const MAX_MODELS = 128;
const MAX_COMMANDS = 256;
const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 1_024;

const boundedText = (value: string | null | undefined): string =>
  (value ?? "").trim().slice(0, MAX_TEXT_LENGTH);

const boundedId = (value: string): string | undefined =>
  value.length > 0 && value === value.trim() && value.length <= MAX_ID_LENGTH ? value : undefined;

export interface ZCodeLiveModel {
  readonly id: string;
  readonly name: string;
}

/** The model list and session options the latest ZCode session advertised. */
export interface ZCodeLiveConfiguration {
  readonly models: ReadonlyArray<ZCodeLiveModel>;
  readonly configOptions: ReadonlyArray<ProviderOptionDescriptor>;
}

/** The latest ZCode command advertisement, split into T3's `/` and `$` menus. */
export interface ZCodeAvailableCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export interface ZCodeLiveStateValue {
  readonly configuration: ZCodeLiveConfiguration | undefined;
  readonly commands: ZCodeAvailableCommands | undefined;
}

function normalizeZCodeLiveConfiguration(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modeState: AcpSessionModeState | undefined,
): ZCodeLiveConfiguration {
  const modelOption = configOptions.find(
    (option) => option.category === "model" && option.type === "select",
  );
  const seen = new Set<string>();
  const models: Array<ZCodeLiveModel> = [];
  if (modelOption?.type === "select") {
    for (const entry of modelOption.options.flatMap((candidate) =>
      "value" in candidate ? [candidate] : candidate.options,
    )) {
      const id = boundedId(entry.value);
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: boundedText(entry.name) || id });
      if (models.length === MAX_MODELS) break;
    }
  }
  return { models, configOptions: acpProviderOptionDescriptors({ configOptions, modeState }) };
}

export function normalizeZCodeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ZCodeAvailableCommands {
  const seen = new Set<string>();
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    const name = boundedId(command.name);
    if (name === undefined || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const description = boundedText(command.description);
    const hint = command.input ? boundedText(command.input.hint) : "";
    if (name.startsWith("$")) {
      const skillName = boundedId(name.slice(1));
      if (skillName === undefined) continue;
      skills.push({
        name: skillName,
        ...(description ? { description } : {}),
        path: `acp://skill/${encodeURIComponent(skillName)}`,
        scope: "agent",
        enabled: true,
      });
    } else {
      slashCommands.push({
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
    }
    if (slashCommands.length + skills.length === MAX_COMMANDS) break;
  }
  return { slashCommands, skills };
}

/**
 * What live sessions of one ZCode instance advertised. ZCode lists models,
 * options, and commands only inside a session, and status checks must not open
 * one, so the instance's snapshot follows its sessions instead.
 */
export interface ZCodeLiveState {
  readonly get: Effect.Effect<ZCodeLiveStateValue>;
  readonly changes: Stream.Stream<ZCodeLiveStateValue>;
  readonly publishConfiguration: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    modeState: AcpSessionModeState | undefined,
  ) => Effect.Effect<void>;
  readonly publishCommands: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
}

export const makeZCodeLiveState: Effect.Effect<ZCodeLiveState> = Effect.map(
  SubscriptionRef.make<ZCodeLiveStateValue>({ configuration: undefined, commands: undefined }),
  (ref) => ({
    get: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref),
    publishConfiguration: (configOptions, modeState) =>
      SubscriptionRef.update(ref, (state) => ({
        ...state,
        configuration: normalizeZCodeLiveConfiguration(configOptions, modeState),
      })),
    publishCommands: (commands) =>
      SubscriptionRef.update(ref, (state) => ({
        ...state,
        commands: normalizeZCodeCommands(commands),
      })),
  }),
);
