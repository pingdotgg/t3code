import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";

export type ThreadSettingsOptionItem =
  | {
      readonly kind: "descriptor";
      readonly descriptor: ProviderOptionDescriptor;
    }
  | { readonly kind: "interaction-mode" };

/**
 * Plan mode belongs directly after Fast Mode when that provider option is
 * available. Providers without Fast Mode still get the new-task control at
 * the end of their provider-specific options.
 */
export function buildThreadSettingsOptionItems(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  includeInteractionMode: boolean,
): ReadonlyArray<ThreadSettingsOptionItem> {
  const items: Array<ThreadSettingsOptionItem> = [];
  let insertedInteractionMode = false;

  for (const descriptor of descriptors) {
    items.push({ kind: "descriptor", descriptor });
    if (includeInteractionMode && descriptor.id === "fastMode") {
      items.push({ kind: "interaction-mode" });
      insertedInteractionMode = true;
    }
  }

  if (includeInteractionMode && !insertedInteractionMode) {
    items.push({ kind: "interaction-mode" });
  }

  return items;
}

/**
 * Desktop-oriented effort keywords that don't belong in the phone picker.
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not
 * a reasoning level. A value set elsewhere still displays, it just isn't
 * offered.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    mode: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    mode: "auto",
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}
