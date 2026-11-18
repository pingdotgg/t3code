import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { type CustomModelDefinition, createModelCapabilities } from "@t3tools/shared/model";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export interface EditorChoice {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly description?: string;
}

export interface EditorDescriptor {
  readonly key: string;
  readonly type: "select" | "boolean";
  readonly id: string;
  readonly label: string;
  readonly choices: ReadonlyArray<EditorChoice>;
  readonly currentBooleanValue?: boolean | undefined;
  readonly description?: string | undefined;
}

export interface CustomModelDraft {
  readonly slug: string;
  readonly name: string;
  readonly descriptors: ReadonlyArray<EditorDescriptor>;
}

export interface DescriptorPreset {
  readonly id: string;
  readonly label: string;
  readonly type: "select" | "boolean";
  readonly choices?: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>;
}

const EFFORT_CHOICES = [
  { id: "low", label: msg("Low", { $context: "reasoning level" }) },
  { id: "medium", label: msg("Medium", { $context: "reasoning level" }), isDefault: true },
  { id: "high", label: msg("High", { $context: "reasoning level" }) },
  { id: "xhigh", label: msg("Extra High", { $context: "reasoning level" }) },
] as const;

export const DESCRIPTOR_PRESETS_BY_KIND: Partial<
  Record<ProviderDriverKind, ReadonlyArray<DescriptorPreset>>
> = {
  [ProviderDriverKind.make("codex")]: [
    {
      id: "reasoningEffort",
      label: msg("Reasoning", { $context: "model option name" }),
      type: "select",
      choices: EFFORT_CHOICES,
    },
    {
      id: "serviceTier",
      label: msg("Speed", { $context: "model option name" }),
      type: "select",
      choices: [
        { id: "default", label: msg("Standard", { $context: "speed tier" }), isDefault: true },
        { id: "fast", label: msg("Fast", { $context: "speed tier" }) },
      ],
    },
  ],
  [ProviderDriverKind.make("claudeAgent")]: [
    {
      id: "effort",
      label: msg("Reasoning", { $context: "model option name" }),
      type: "select",
      choices: [
        { id: "low", label: msg("Low", { $context: "reasoning level" }) },
        { id: "medium", label: msg("Medium", { $context: "reasoning level" }) },
        { id: "high", label: msg("High", { $context: "reasoning level" }), isDefault: true },
        { id: "xhigh", label: msg("Extra High", { $context: "reasoning level" }) },
        { id: "max", label: msg("Max", { $context: "reasoning level" }) },
      ],
    },
    { id: "fastMode", label: msg("Fast Mode", { $context: "model option name" }), type: "boolean" },
    { id: "thinking", label: msg("Thinking", { $context: "model option name" }), type: "boolean" },
  ],
  [ProviderDriverKind.make("cursor")]: [
    {
      id: "reasoning",
      label: msg("Reasoning", { $context: "model option name" }),
      type: "select",
      choices: EFFORT_CHOICES,
    },
    { id: "fastMode", label: msg("Fast Mode", { $context: "model option name" }), type: "boolean" },
    { id: "thinking", label: msg("Thinking", { $context: "model option name" }), type: "boolean" },
  ],
  [ProviderDriverKind.make("grok")]: [
    {
      id: "reasoningEffort",
      label: msg("Reasoning", { $context: "model option name" }),
      type: "select",
      choices: EFFORT_CHOICES,
    },
  ],
  [ProviderDriverKind.make("pi")]: [
    {
      id: "thinking",
      label: msg("Thinking", { $context: "model option name" }),
      type: "select",
      choices: [
        { id: "off", label: msg("Off", { $context: "reasoning level" }) },
        { id: "minimal", label: msg("Minimal", { $context: "reasoning level" }) },
        { id: "low", label: msg("Low", { $context: "reasoning level" }) },
        { id: "medium", label: msg("Medium", { $context: "reasoning level" }), isDefault: true },
        { id: "high", label: msg("High", { $context: "reasoning level" }) },
        { id: "xhigh", label: msg("Extra High", { $context: "reasoning level" }) },
        { id: "max", label: msg("Max", { $context: "reasoning level" }) },
      ],
    },
  ],
  [ProviderDriverKind.make("opencode")]: [
    {
      id: "variant",
      label: msg("Reasoning", { $context: "model option name" }),
      type: "select",
      choices: EFFORT_CHOICES,
    },
    {
      id: "agent",
      label: msg("Agent", { $context: "model option name" }),
      type: "select",
      choices: [
        { id: "build", label: msg("Build", { $context: "OpenCode agent name" }), isDefault: true },
        { id: "plan", label: msg("Plan", { $context: "OpenCode agent name" }) },
      ],
    },
  ],
};

let nextKey = 0;
function newEditorKey(): string {
  nextKey += 1;
  return `k${nextKey}`;
}

export function choiceFromPreset(choice: {
  id: string;
  label: string;
  isDefault?: boolean;
}): EditorChoice {
  return { key: newEditorKey(), id: choice.id, label: choice.label, isDefault: !!choice.isDefault };
}

export function descriptorFromPreset(preset: DescriptorPreset): EditorDescriptor {
  return {
    key: newEditorKey(),
    type: preset.type,
    id: preset.id,
    label: preset.label,
    choices: (preset.choices ?? []).map(choiceFromPreset),
  };
}

export function emptyEditorDescriptor(): EditorDescriptor {
  return { key: newEditorKey(), type: "select", id: "", label: "", choices: [] };
}

export function emptyEditorChoice(): EditorChoice {
  return { key: newEditorKey(), id: "", label: "", isDefault: false };
}

/** Custom entries lack runtime profiles for prompt-injected choices, so do not store them as ordinary
 * options. */
function descriptorToEditor(descriptor: ProviderOptionDescriptor): EditorDescriptor {
  const promptInjected = new Set(
    descriptor.type === "select" ? (descriptor.promptInjectedValues ?? []) : [],
  );
  const choices =
    descriptor.type === "select"
      ? descriptor.options.filter((option) => !promptInjected.has(option.id))
      : [];
  const defaultChoice =
    choices.find((option) => option.id === descriptor.currentValue) ??
    choices.find((option) => option.isDefault);
  return {
    key: newEditorKey(),
    type: descriptor.type,
    id: descriptor.id,
    label: descriptor.label,
    ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
    ...(descriptor.type === "boolean" && descriptor.currentValue !== undefined
      ? { currentBooleanValue: descriptor.currentValue }
      : {}),
    choices: choices.map((option) => ({
      key: newEditorKey(),
      id: option.id,
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
      isDefault: option === defaultChoice,
    })),
  };
}

export function draftFromDefinition(entry: CustomModelDefinition): CustomModelDraft {
  return {
    slug: entry.slug,
    name: entry.name === entry.slug ? "" : entry.name,
    descriptors: (entry.capabilities?.optionDescriptors ?? []).map(descriptorToEditor),
  };
}

/** Claude context choices require runtime suffix mappings that custom entries do not carry. */
export function descriptorsFromCapabilities(
  capabilities: ModelCapabilities | null | undefined,
  driverKind: ProviderDriverKind | null,
): EditorDescriptor[] {
  return (capabilities?.optionDescriptors ?? [])
    .filter((descriptor) => driverKind !== "claudeAgent" || descriptor.id !== "contextWindow")
    .map(descriptorToEditor);
}

export function validateDraft(
  draft: CustomModelDraft,
  resolve: MessageResolver = m,
): string | null {
  const seenIds = new Set<string>();
  for (const [index, descriptor] of draft.descriptors.entries()) {
    const position = index + 1;
    const id = descriptor.id.trim();
    if (!id) return resolve(msg("Option {position} needs an id.", { position }));
    if (seenIds.has(id))
      return resolve(msg('Option {position}: id "{id}" is used twice.', { position, id }));
    seenIds.add(id);
    if (!descriptor.label.trim())
      return resolve(msg("Option {position} needs a label.", { position }));
    if (descriptor.type !== "select") continue;
    if (descriptor.choices.length === 0)
      return resolve(msg("Option {position} needs at least one choice.", { position }));
    const seenChoices = new Set<string>();
    for (const choice of descriptor.choices) {
      const choiceId = choice.id.trim();
      if (!choiceId)
        return resolve(msg("Option {position} has a choice without a value.", { position }));
      if (seenChoices.has(choiceId)) {
        return resolve(
          msg('Option {position}: choice "{choiceId}" is used twice.', { position, choiceId }),
        );
      }
      seenChoices.add(choiceId);
    }
  }
  return null;
}

export function definitionFromDraft(draft: CustomModelDraft): CustomModelDefinition {
  const descriptors: ProviderOptionDescriptor[] = draft.descriptors.map((descriptor) => {
    const id = descriptor.id.trim();
    const label = descriptor.label.trim();
    if (descriptor.type === "boolean") {
      return {
        id,
        label,
        type: "boolean",
        ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
        ...(descriptor.currentBooleanValue !== undefined
          ? { currentValue: descriptor.currentBooleanValue }
          : {}),
      };
    }
    const options = descriptor.choices.map((choice) => ({
      id: choice.id.trim(),
      label: choice.label.trim() || choice.id.trim(),
      ...(choice.description !== undefined ? { description: choice.description } : {}),
      ...(choice.isDefault ? { isDefault: true } : {}),
    }));
    const currentValue = options.find((option) => option.isDefault)?.id;
    return {
      id,
      label,
      type: "select",
      ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
      options,
      ...(currentValue ? { currentValue } : {}),
    };
  });
  const name = draft.name.trim();
  return {
    slug: draft.slug,
    name: name || draft.slug,
    capabilities:
      descriptors.length > 0 ? createModelCapabilities({ optionDescriptors: descriptors }) : null,
  };
}
