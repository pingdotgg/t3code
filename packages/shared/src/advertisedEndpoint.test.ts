import { describe, expect, it } from "vite-plus/test";

import {
  AdvertisedEndpointProtocolError,
  AdvertisedEndpointUrlParseError,
  normalizeHttpBaseUrl,
} from "./advertisedEndpoint.ts";

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to throw");
};

describe("advertised endpoints", () => {
  it("normalizes websocket endpoints to an HTTP base URL", () => {
    expect(normalizeHttpBaseUrl("wss://relay.example.com/path?query=value#fragment")).toBe(
      "https://relay.example.com/",
    );
  });

  it("preserves URL parser failures without retaining their raw input", () => {
    const input = "not a URL";
    const error = captureError(() => normalizeHttpBaseUrl(input));

    expect(error).toBeInstanceOf(AdvertisedEndpointUrlParseError);
    expect(error).toMatchObject({ inputLength: input.length });
    expect(error).not.toHaveProperty("input");
    expect((error as AdvertisedEndpointUrlParseError).cause).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid advertised endpoint URL.");
  });

  it("reports unsupported protocols without inventing a cause", () => {
    const input =
      "ftp://endpoint-user:endpoint-password@relay.example.com/private/path?token=secret#fragment";
    const error = captureError(() => normalizeHttpBaseUrl(input));

    expect(error).toBeInstanceOf(AdvertisedEndpointProtocolError);
    expect(error).toMatchObject({
      inputLength: input.length,
      inputProtocol: "ftp:",
      inputHostname: "relay.example.com",
      protocol: "ftp:",
    });
    expect(error).not.toHaveProperty("input");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((error as Error).message).toBe("Endpoint must use HTTP or HTTPS. Received ftp:");
    expect((error as Error).message).not.toContain("endpoint-password");
    expect((error as Error).message).not.toContain("/private/path");
    expect((error as Error).message).not.toContain("token=secret");
  });
});
