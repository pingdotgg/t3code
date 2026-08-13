import { describe, expect, it } from "@effect/vitest";

import { buildAetherPreviewUrl, deriveAetherPreviewDomain } from "./portPreview.ts";

// A valid gateway token: 32 lowercase-alphanumeric chars.
const TOKEN = "abcdef0123456789abcdef0123456789";

describe("deriveAetherPreviewDomain", () => {
  it("swaps a leading api. label for preview.", () => {
    expect(deriveAetherPreviewDomain("https://api.runaether.dev")).toBe("preview.runaether.dev");
    expect(deriveAetherPreviewDomain("https://api.staging.runaether.dev")).toBe(
      "preview.staging.runaether.dev",
    );
  });

  it("returns a non-api host unchanged and falls back on an unparseable URL", () => {
    expect(deriveAetherPreviewDomain("http://localhost:8080")).toBe("localhost:8080");
    expect(deriveAetherPreviewDomain("not a url")).toBe("preview.runaether.dev");
  });
});

describe("buildAetherPreviewUrl", () => {
  it("builds {port}-{workspaceId8}-{token}.preview.runaether.dev for the prod api base", () => {
    expect(
      buildAetherPreviewUrl({
        apiBaseUrl: "https://api.runaether.dev",
        workspaceId: "1a2b3c4d5e6f7890",
        port: 3000,
        previewToken: TOKEN,
      }),
    ).toBe(`https://3000-1a2b3c4d-${TOKEN}.preview.runaether.dev`);
  });

  it("uses http for a localhost preview domain", () => {
    expect(
      buildAetherPreviewUrl({
        apiBaseUrl: "http://localhost:8080",
        workspaceId: "abcdefgh1234",
        port: 5173,
        previewToken: TOKEN,
      }),
    ).toBe(`http://5173-abcdefgh-${TOKEN}.localhost:8080`);
  });

  it("follows the api base protocol for an http-only self-hosted instance", () => {
    // The preview gateway of an http-only instance is http too — emitting
    // https for every non-localhost host produced an unreachable URL.
    expect(
      buildAetherPreviewUrl({
        apiBaseUrl: "http://api.aether.internal",
        workspaceId: "abcdefgh1234",
        port: 3000,
        previewToken: TOKEN,
      }),
    ).toBe(`http://3000-abcdefgh-${TOKEN}.preview.aether.internal`);
    // An unparseable base pairs with the production preview domain: https.
    expect(
      buildAetherPreviewUrl({
        apiBaseUrl: "not a url",
        workspaceId: "abcdefgh1234",
        port: 3000,
        previewToken: TOKEN,
      }),
    ).toBe(`https://3000-abcdefgh-${TOKEN}.preview.runaether.dev`);
  });

  it("skips the preview for an IP-literal host, which cannot carry a subdomain", () => {
    // Prefixing the token label yields a name that resolves nowhere for IPv4
    // and an invalid URL for IPv6 — offering no link beats offering a dead one.
    for (const apiBaseUrl of ["http://127.0.0.1:8080", "http://[::1]:8080"]) {
      expect(
        buildAetherPreviewUrl({
          apiBaseUrl,
          workspaceId: "abcdefgh1234",
          port: 3000,
          previewToken: TOKEN,
        }),
      ).toBeUndefined();
    }
    // …but `*.localhost` resolves to loopback in every browser, so it stays.
    expect(
      buildAetherPreviewUrl({
        apiBaseUrl: "http://localhost:8080",
        workspaceId: "abcdefgh1234",
        port: 3000,
        previewToken: TOKEN,
      }),
    ).toBe(`http://3000-abcdefgh-${TOKEN}.localhost:8080`);
  });

  it("returns undefined for a malformed token (best-effort, never throws)", () => {
    expect(
      buildAetherPreviewUrl({
        apiBaseUrl: "https://api.runaether.dev",
        workspaceId: "1a2b3c4d",
        port: 3000,
        previewToken: "short",
      }),
    ).toBeUndefined();
    // Uppercase is not allowed by the gateway pattern.
    expect(
      buildAetherPreviewUrl({
        apiBaseUrl: "https://api.runaether.dev",
        workspaceId: "1a2b3c4d",
        port: 3000,
        previewToken: "ABCDEF0123456789abcdef0123456789",
      }),
    ).toBeUndefined();
  });
});
