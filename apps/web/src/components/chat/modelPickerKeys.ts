import type { ProviderInstanceId } from "@t3tools/contracts";

const MODEL_KEY_PREFIX = "model:";
const LEGACY_SECTION_KEY_PREFIX = "legacy-models:";
const VENDOR_SECTION_KEY_PREFIX = "vendor-section:";

function encodeInstanceKey(prefix: string, instanceId: ProviderInstanceId, rest: string): string {
  return `${prefix}${instanceId.length}:${instanceId}${rest}`;
}

function decodeInstanceKey(
  prefix: string,
  key: string,
): { instanceId: ProviderInstanceId; rest: string } | null {
  if (!key.startsWith(prefix)) {
    return null;
  }
  const encoded = key.slice(prefix.length);
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
    rest: value.slice(instanceIdLength),
  };
}

export function modelPickerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return encodeInstanceKey(MODEL_KEY_PREFIX, instanceId, slug);
}

export function parseModelPickerModelKey(
  key: string,
): { instanceId: ProviderInstanceId; slug: string } | null {
  const decoded = decodeInstanceKey(MODEL_KEY_PREFIX, key);
  return decoded ? { instanceId: decoded.instanceId, slug: decoded.rest } : null;
}

export function modelPickerVendorSectionKey(
  instanceId: ProviderInstanceId,
  vendor: string,
): string {
  return encodeInstanceKey(VENDOR_SECTION_KEY_PREFIX, instanceId, vendor);
}

export function modelPickerLegacySectionKey(instanceId: ProviderInstanceId): string {
  return `${LEGACY_SECTION_KEY_PREFIX}${instanceId}`;
}

export function parseModelPickerLegacySectionKey(key: string): ProviderInstanceId | null {
  return key.startsWith(LEGACY_SECTION_KEY_PREFIX)
    ? (key.slice(LEGACY_SECTION_KEY_PREFIX.length) as ProviderInstanceId)
    : null;
}
