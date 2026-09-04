import { readHostedPairingRequest } from "@t3tools/shared/remote";
import { isT3ConnectionCode, peekT3ConnectionCodeKind } from "@t3tools/shared/t3ConnectionCode";
import * as Schema from "effect/Schema";

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

function isIpLiteral(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    if (hostname.includes(":")) return true;

    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

export class PairingQrPayloadEmptyError extends Schema.TaggedErrorClass<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return "Scanned QR code did not contain a pairing URL.";
  }
}

/**
 * A `t3c://` connection code was entered where a pairing URL belongs. Those
 * codes are redeemed by the desktop app (which runs the Tailcat tunnel), so
 * the message points there instead of calling the input an invalid URL.
 */
export class PairingInputNotPairableError extends Schema.TaggedErrorClass<PairingInputNotPairableError>()(
  "PairingInputNotPairableError",
  {
    kind: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    switch (this.kind) {
      case "tailcat":
        return "This is a Tailcat connection code. Paste it in the desktop app under Add environment → Tailcat.";
      case "peer":
        return "This is a federation peer code. Add it in the desktop app under Settings → Connections → Federation.";
      default:
        return "This is a T3 connection code, not a pairing URL. Use it in the desktop app.";
    }
  }
}

/** Guidance for inputs that are T3 connection codes rather than pairing URLs; null for everything else. */
export function unsupportedPairingInputMessage(input: string): string | null {
  const trimmed = input.trim();
  if (!isT3ConnectionCode(trimmed)) return null;
  return new PairingInputNotPairableError({ kind: peekT3ConnectionCodeKind(trimmed) }).message;
}

export function buildPairingUrl(host: string, code: string): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  if (!c) return h;

  try {
    const url = new URL(h.includes("://") ? h : `${isIpLiteral(h) ? "http" : "https"}://${h}`);
    url.hash = new URLSearchParams([["token", c]]).toString();
    return url.toString();
  } catch {
    return `${h}#token=${c}`;
  }
}

export function parsePairingUrl(url: string): { host: string; code: string } {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "" };
  // Keep a pasted connection code intact so the guidance error matches what the user sees.
  if (isT3ConnectionCode(trimmed)) return { host: trimmed, code: "" };

  try {
    const parsed = new URL(trimmed);
    const hostedPairingRequest = readHostedPairingRequest(parsed);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host.replace(/\/$/, ""),
        code: hostedPairingRequest.token,
      };
    }

    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return { host: parsed.toString().replace(/\/$/, ""), code };
  } catch {
    return { host: trimmed, code: "" };
  }
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new PairingQrPayloadEmptyError({});
  }
  if (isT3ConnectionCode(trimmed)) {
    throw new PairingInputNotPairableError({ kind: peekT3ConnectionCodeKind(trimmed) });
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "t3code:") {
      const pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
      if (pairingUrl.length > 0) {
        return pairingUrl;
      }
    }
  } catch {
    // Treat non-URL payloads as raw pairing-url text so the normal input validation can decide.
  }

  return trimmed;
}
