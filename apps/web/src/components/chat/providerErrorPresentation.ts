const PROVIDER_PROTOCOL_PREFIX =
  /^(?:ProviderAdapterProtocolError:\s*)?([a-z][a-z0-9_-]*) provider protocol error:\s*/iu;
const PROVIDER_TURN_START =
  /^Failed to start run .+ on ([a-z][a-z0-9_-]*) provider thread .+\.?$/iu;

function providerLabel(slug: string): string {
  if (slug.toLowerCase() === "hermes") return "Hermes";
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function withoutTrailingPeriod(message: string): string {
  return message.trim().replace(/\.+$/u, "");
}

/**
 * Provider errors cross several Effect/RPC wrappers before reaching the
 * timeline. Present known operational failures as a next step instead of
 * exposing adapter names, run ids, or provider-thread ids.
 */
export function presentProviderError(message: string): string {
  const trimmed = message.trim();
  const protocolMatch = PROVIDER_PROTOCOL_PREFIX.exec(trimmed);
  if (protocolMatch) {
    const provider = providerLabel(protocolMatch[1]!);
    const detail = withoutTrailingPeriod(trimmed.slice(protocolMatch[0].length));
    if (/^Attachments are disabled for this Hermes instance$/iu.test(detail)) {
      return "Hermes attachments are turned off. Enable Attachments in Settings → Providers, then try again.";
    }
    if (/^Hermes attachment storage is unavailable$/iu.test(detail)) {
      return "T3 couldn't access the Hermes attachment storage. Remove and reattach the file, then try again.";
    }
    const unsupportedAttachment =
      /^This Hermes gateway does not support (image|PDF|video|file) attachments$/iu.exec(detail);
    if (unsupportedAttachment) {
      const kind = unsupportedAttachment[1]!.toLowerCase();
      return `This Hermes gateway does not support ${kind} attachments. Remove the ${kind} attachment or update the gateway, then try again.`;
    }
    return `${provider} couldn't complete the request: ${detail}. Check the provider connection in Settings → Providers, then try again.`;
  }

  const turnStartMatch = PROVIDER_TURN_START.exec(trimmed);
  if (turnStartMatch) {
    const provider = providerLabel(turnStartMatch[1]!);
    return `${provider} couldn't start this message. Check the provider connection in Settings → Providers, then try again.`;
  }

  return trimmed;
}
