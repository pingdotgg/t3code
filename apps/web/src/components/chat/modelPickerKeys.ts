import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

const MODEL_KEY_PREFIX = "model:";
const LEGACY_SECTION_KEY_PREFIX = "legacy-models:";
const PROVIDER_GROUP_KEY_PREFIX = "provider-group:";

export function modelPickerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${MODEL_KEY_PREFIX}${instanceId.length}:${instanceId}${slug}`;
}

export function parseModelPickerModelKey(
  key: string,
): { instanceId: ProviderInstanceId; slug: string } | null {
  if (!key.startsWith(MODEL_KEY_PREFIX)) {
    return null;
  }
  const encoded = key.slice(MODEL_KEY_PREFIX.length);
  const separatorIndex = encoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const instanceIdLengthText = encoded.slice(0, separatorIndex);
  if (!/^\d+$/.test(instanceIdLengthText)) {
    return null;
  }

  const instanceIdLength = Number(instanceIdLengthText);
  const value = encoded.slice(separatorIndex + 1);
  if (!Number.isSafeInteger(instanceIdLength) || instanceIdLength > value.length) {
    return null;
  }

  return {
    instanceId: value.slice(0, instanceIdLength) as ProviderInstanceId,
    slug: value.slice(instanceIdLength),
  };
}

export function modelPickerLegacySectionKey(instanceId: ProviderInstanceId): string {
  return `${LEGACY_SECTION_KEY_PREFIX}${instanceId}`;
}

export function parseModelPickerLegacySectionKey(key: string): ProviderInstanceId | null {
  return key.startsWith(LEGACY_SECTION_KEY_PREFIX)
    ? (key.slice(LEGACY_SECTION_KEY_PREFIX.length) as ProviderInstanceId)
    : null;
}

export function modelPickerProviderGroupKey(driverKind: ProviderDriverKind): string {
  return `${PROVIDER_GROUP_KEY_PREFIX}${driverKind}`;
}

export function parseModelPickerProviderGroupKey(key: string): ProviderDriverKind | null {
  return key.startsWith(PROVIDER_GROUP_KEY_PREFIX)
    ? (key.slice(PROVIDER_GROUP_KEY_PREFIX.length) as ProviderDriverKind)
    : null;
}
