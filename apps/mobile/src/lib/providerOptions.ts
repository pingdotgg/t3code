import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

const PROVIDER_OPTION_EVENT_PREFIX = "provider-option:";

export const LOCKED_PROVIDER_OPTION_ALERT = {
  title: "Start a new chat to change options",
  description: "This provider applies these options when a conversation starts.",
} as const;

export type ProviderOptionMenuChangeResolution =
  | { action: "ignore" }
  | {
      action: "warn";
      title: (typeof LOCKED_PROVIDER_OPTION_ALERT)["title"];
      description: (typeof LOCKED_PROVIDER_OPTION_ALERT)["description"];
    }
  | { action: "apply"; options: ReadonlyArray<ProviderOptionSelection> };

function providerOptionEvent(id: string, value: string | boolean): string {
  return `${PROVIDER_OPTION_EVENT_PREFIX}${encodeURIComponent(JSON.stringify({ id, value }))}`;
}

function parseProviderOptionEvent(
  event: string,
): { readonly id: string; readonly value: string | boolean } | null {
  if (!event.startsWith(PROVIDER_OPTION_EVENT_PREFIX)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      decodeURIComponent(event.slice(PROVIDER_OPTION_EVENT_PREFIX.length)),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof parsed.id === "string" &&
      "value" in parsed &&
      (typeof parsed.value === "string" || typeof parsed.value === "boolean")
    ) {
      return { id: parsed.id, value: parsed.value };
    }
  } catch {
    return null;
  }

  return null;
}

function descriptorCurrentValue(
  descriptor: ProviderOptionDescriptor,
): string | boolean | undefined {
  if (descriptor.type === "boolean") {
    return descriptor.currentValue ?? false;
  }
  return getProviderOptionCurrentValue(descriptor);
}

function tryBuildProviderOptionUpdate(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  event: string,
): {
  readonly currentValue: string | boolean | undefined;
  readonly nextValue: string | boolean;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
} | null {
  const selection = parseProviderOptionEvent(event);
  if (!selection) {
    return null;
  }

  const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof selection.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof selection.value !== "string" ||
        !descriptor.options.some((option) => option.id === selection.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: selection.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  return {
    currentValue: descriptorCurrentValue(descriptor),
    nextValue: selection.value,
    options: buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [],
  };
}

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: input.selections,
  });
}

export function buildProviderOptionMenuActions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<MenuAction> {
  return descriptors.map((descriptor) => {
    const currentValue = descriptorCurrentValue(descriptor);
    const choices =
      descriptor.type === "select"
        ? descriptor.options.map((option) => ({
            id: providerOptionEvent(descriptor.id, option.id),
            title: `${option.label}${option.isDefault ? " (default)" : ""}`,
            state: currentValue === option.id ? ("on" as const) : undefined,
          }))
        : ([false, true] as const).map((value) => ({
            id: providerOptionEvent(descriptor.id, value),
            title: value ? "On" : "Off",
            state: currentValue === value ? ("on" as const) : undefined,
          }));

    return {
      id: `provider-option-menu:${descriptor.id}`,
      title: descriptor.label,
      subtitle:
        descriptor.type === "boolean"
          ? currentValue
            ? "On"
            : "Off"
          : getProviderOptionCurrentLabel(descriptor),
      subactions: choices,
    };
  });
}

export function providerOptionsConfigurationLabel(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): string {
  const labels = descriptors.flatMap((descriptor) => {
    if (descriptor.type === "boolean") {
      return descriptor.currentValue ? [descriptor.label] : [];
    }
    const label = getProviderOptionCurrentLabel(descriptor);
    return label ? [label] : [];
  });
  return labels.length > 0 ? labels.join(" · ") : "Configuration";
}

/**
 * Parse a provider-option menu event and decide ignore / warn / apply.
 * Used by ThreadComposer so locked alternates stay tappable and warn, while
 * re-selecting the current value is a silent no-op.
 */
export function resolveProviderOptionMenuChange(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  event: string,
  input?: { readonly optionsLocked?: boolean },
): ProviderOptionMenuChangeResolution | null {
  const update = tryBuildProviderOptionUpdate(descriptors, event);
  if (!update) {
    return null;
  }
  if (update.currentValue === update.nextValue) {
    return { action: "ignore" };
  }
  if (input?.optionsLocked === true) {
    return {
      action: "warn",
      title: LOCKED_PROVIDER_OPTION_ALERT.title,
      description: LOCKED_PROVIDER_OPTION_ALERT.description,
    };
  }
  return { action: "apply", options: update.options };
}

/** Always applies a valid provider-option event (new-thread drafts stay fully mutable). */
export function applyProviderOptionMenuEvent(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  event: string,
): ReadonlyArray<ProviderOptionSelection> | null {
  return tryBuildProviderOptionUpdate(descriptors, event)?.options ?? null;
}
