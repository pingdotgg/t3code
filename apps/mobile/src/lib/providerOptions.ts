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
    const currentValue =
      descriptor.type === "boolean"
        ? (descriptor.currentValue ?? false)
        : getProviderOptionCurrentValue(descriptor);
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

export function applyProviderOptionMenuEvent(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  event: string,
): ReadonlyArray<ProviderOptionSelection> | null {
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

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}
