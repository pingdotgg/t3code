import type {
  AdvertisedEndpoint,
  AdvertisedEndpointHostedHttpsCompatibility,
  AdvertisedEndpointProvider,
  AdvertisedEndpointReachability,
  AdvertisedEndpointSource,
  AdvertisedEndpointStatus,
} from "@t3tools/contracts";

import { ROOT_BASE_PATH, type NormalizedBasePath } from "./basePath.ts";

export interface CreateAdvertisedEndpointInput {
  readonly id: string;
  readonly label: string;
  readonly provider: AdvertisedEndpointProvider;
  readonly httpBaseUrl: string;
  readonly basePath?: NormalizedBasePath;
  readonly reachability: AdvertisedEndpointReachability;
  readonly hostedHttpsCompatibility?: AdvertisedEndpointHostedHttpsCompatibility;
  readonly desktopCompatibility?: "compatible" | "unknown";
  readonly source: AdvertisedEndpointSource;
  readonly status?: AdvertisedEndpointStatus;
  readonly isDefault?: boolean;
  readonly description?: string;
}

export interface AdvertisedEndpointBaseUrlOptions {
  readonly basePath?: NormalizedBasePath;
}

export function normalizeHttpBaseUrl(
  rawValue: string,
  options?: AdvertisedEndpointBaseUrlOptions,
): string {
  const url = new URL(rawValue);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Endpoint must use HTTP or HTTPS. Received ${url.protocol}`);
  }
  url.pathname = `${options?.basePath ?? ROOT_BASE_PATH}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function deriveWsBaseUrl(
  httpBaseUrl: string,
  options?: AdvertisedEndpointBaseUrlOptions,
): string {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl, options));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function classifyHostedHttpsCompatibility(
  httpBaseUrl: string,
  fallback: AdvertisedEndpointHostedHttpsCompatibility = "unknown",
  options?: AdvertisedEndpointBaseUrlOptions,
): AdvertisedEndpointHostedHttpsCompatibility {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl, options));
  if (url.protocol === "http:") {
    return "mixed-content-blocked";
  }
  return fallback === "mixed-content-blocked" ? "unknown" : fallback;
}

export function createAdvertisedEndpoint(input: CreateAdvertisedEndpointInput): AdvertisedEndpoint {
  const baseUrlOptions =
    input.basePath === undefined ? undefined : ({ basePath: input.basePath } as const);
  const httpBaseUrl = normalizeHttpBaseUrl(input.httpBaseUrl, baseUrlOptions);
  return {
    id: input.id,
    label: input.label,
    provider: input.provider,
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl, baseUrlOptions),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp:
        input.hostedHttpsCompatibility ??
        classifyHostedHttpsCompatibility(httpBaseUrl, "unknown", baseUrlOptions),
      desktopApp: input.desktopCompatibility ?? "compatible",
    },
    source: input.source,
    status: input.status ?? "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}
