import { EnvironmentRenderBootstrapPairingResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const RenderBootstrapErrorBody = Schema.Struct({ message: Schema.String });
const decodeRenderBootstrapErrorBody = Schema.decodeUnknownOption(RenderBootstrapErrorBody);
const decodeRenderBootstrapPairingResult = Schema.decodeUnknownSync(
  EnvironmentRenderBootstrapPairingResult,
);

export class RenderBootstrapRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "RenderBootstrapRequestError";
    this.status = status;
  }
}

export function normalizeRenderServiceUrl(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0) {
    throw new RenderBootstrapRequestError("Enter the Render service URL.");
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    throw new RenderBootstrapRequestError("Enter a valid Render service URL.");
  }
  if (url.protocol !== "https:") {
    throw new RenderBootstrapRequestError("Render service URLs must use HTTPS.");
  }
  if (url.hostname.toLowerCase() === "dashboard.render.com") {
    throw new RenderBootstrapRequestError(
      "Paste the service's .onrender.com URL, not the Render dashboard URL.",
    );
  }
  return url.origin;
}

export function maskedRenderServiceUrl(value: string): string {
  try {
    const hostname = new URL(value).hostname;
    if (hostname.length <= 28) return hostname;
    return `${hostname.slice(0, 13)}…${hostname.slice(-14)}`;
  } catch {
    return "Render service";
  }
}

export async function requestRenderPairing(input: {
  readonly serviceUrl: string;
  readonly fetcher?: typeof globalThis.fetch;
}): Promise<{ readonly host: string; readonly pairingCode: string; readonly label: string }> {
  const host = normalizeRenderServiceUrl(input.serviceUrl);

  const endpoint = new URL("/.well-known/t3/render/pair", host);
  let response: Response;
  try {
    response = await (input.fetcher ?? globalThis.fetch)(endpoint, {
      method: "POST",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new RenderBootstrapRequestError(
      "Could not reach the Render service. A free instance can take about a minute to wake up.",
    );
  }

  const responseBody: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const decodedError = decodeRenderBootstrapErrorBody(responseBody);
    const serverMessage = Option.isSome(decodedError) ? decodedError.value.message : null;
    const message =
      response.status === 403 || response.status === 404
        ? "This service does not have in-app Render pairing yet. Deploy the latest version."
        : serverMessage || `Render pairing failed with HTTP ${response.status}.`;
    throw new RenderBootstrapRequestError(message, response.status);
  }

  try {
    const pairing = decodeRenderBootstrapPairingResult(responseBody);
    return { host, pairingCode: pairing.pairingCode, label: pairing.label };
  } catch {
    throw new RenderBootstrapRequestError("The Render service returned an invalid pairing reply.");
  }
}
