import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import {
  detectComposerTrigger,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";

const BUILT_IN_COMPOSER_SLASH_COMMANDS = [
  {
    id: "cmd:model",
    type: "slash-command" as const,
    command: "model",
    label: "/model",
    description: "Switch model",
  },
  {
    id: "cmd:plan",
    type: "slash-command" as const,
    command: "plan",
    label: "/plan",
    description: "Switch to plan mode",
  },
  {
    id: "cmd:default",
    type: "slash-command" as const,
    command: "default",
    label: "/default",
    description: "Switch to default mode",
  },
] as const;

export function resolvePlanModeEnabled(preference: boolean | undefined): boolean {
  return preference === true;
}

function composerSlashCommandMatchesQuery(command: string, query: string): boolean {
  return command.includes(query.toLowerCase());
}

export function getBuiltInComposerSlashCommands(input: {
  readonly planModeEnabled: boolean;
  readonly query: string;
}) {
  return BUILT_IN_COMPOSER_SLASH_COMMANDS.filter(
    (item) =>
      composerSlashCommandMatchesQuery(item.command, input.query) &&
      (input.planModeEnabled || (item.command !== "plan" && item.command !== "default")),
  );
}

export function getPlanModeComposerSlashCommands(input: {
  readonly planModeEnabled: boolean;
  readonly query: string;
}) {
  return BUILT_IN_COMPOSER_SLASH_COMMANDS.filter(
    (item) =>
      item.command !== "model" &&
      input.planModeEnabled &&
      composerSlashCommandMatchesQuery(item.command, input.query),
  );
}

export function resolveSlashCommandInteractionMode(input: {
  readonly command: string;
  readonly planModeEnabled: boolean;
}): ProviderInteractionMode | null {
  if (!input.planModeEnabled) return null;
  if (input.command === "plan" || input.command === DEFAULT_PROVIDER_INTERACTION_MODE) {
    return input.command;
  }
  return null;
}

export function resolveComposerSubmitInteractionMode(input: {
  readonly text: string;
  readonly attachmentCount: number;
  readonly planModeEnabled: boolean;
}): ProviderInteractionMode | null {
  if (input.attachmentCount > 0) return null;
  const command = parseStandaloneComposerSlashCommand(input.text);
  return command === null
    ? null
    : resolveSlashCommandInteractionMode({ command, planModeEnabled: input.planModeEnabled });
}

export function replaceCurrentComposerTrigger(input: {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly expectedKind: ComposerTrigger["kind"];
  readonly expectedText: string;
  readonly replacement: string;
  readonly extendSlashCommandToken: boolean;
}): { readonly text: string; readonly cursor: number } | null {
  if (input.selection.start !== input.selection.end) return null;
  const trigger = detectComposerTrigger(input.text, input.selection.end);
  if (
    trigger?.kind !== input.expectedKind ||
    input.text.slice(trigger.rangeStart, trigger.rangeEnd) !== input.expectedText
  ) {
    return null;
  }

  let rangeEnd = trigger.rangeEnd;
  if (input.extendSlashCommandToken) {
    while (rangeEnd < input.text.length && !/\s/u.test(input.text[rangeEnd] ?? "")) {
      rangeEnd += 1;
    }
  }

  return replaceTextRange(input.text, trigger.rangeStart, rangeEnd, input.replacement);
}

export function resolveComposerInteractionMode(input: {
  readonly interactionMode: ProviderInteractionMode | null | undefined;
  readonly planModeEnabled: boolean;
}): ProviderInteractionMode {
  return input.planModeEnabled
    ? (input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE)
    : DEFAULT_PROVIDER_INTERACTION_MODE;
}

export function canSubmitExistingThreadDraft(input: {
  readonly hasContent: boolean;
  readonly planModePreferenceLoaded: boolean;
}): boolean {
  return input.hasContent && input.planModePreferenceLoaded;
}

export function resolveComposerEnqueueInteractionMode(input: {
  readonly interactionMode: ProviderInteractionMode | null | undefined;
  readonly planModeEnabled: boolean;
  readonly preferenceLoaded: boolean;
}): ProviderInteractionMode | null {
  return input.preferenceLoaded ? resolveComposerInteractionMode(input) : null;
}
