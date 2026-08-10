import * as NodeCrypto from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

import { decodeReleaseManifest, verifyReleaseArtifacts } from "./verify-release-artifacts";

const bytes = new TextEncoder().encode("verified Auldric release bytes");
const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const artifact = {
  id: "desktop-macos-arm64-v1.2.3",
  url: "https://github.com/AuldricAI/auldrics/releases/download/v1.2.3/Auldric-1.2.3-arm64.dmg",
  fileName: "Auldric-1.2.3-arm64.dmg",
  platform: "macos-apple-silicon",
  version: "1.2.3",
  sha256: digest,
};

describe("verified release manifest", () => {
  it("accepts an empty fail-closed manifest without network access", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      verifyReleaseArtifacts({ schemaVersion: 1, artifacts: [] }, fetcher),
    ).resolves.toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches and hashes every recorded artifact before publication", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, { status: 200 }));
    await expect(
      verifyReleaseArtifacts({ schemaVersion: 1, artifacts: [artifact] }, fetcher),
    ).resolves.toBe(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL(artifact.url),
      expect.objectContaining({
        headers: { "user-agent": "auldric-public-release-verifier" },
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fails when the fetched bytes do not match the committed digest", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("different bytes", { status: 200 }));
    await expect(
      verifyReleaseArtifacts({ schemaVersion: 1, artifacts: [artifact] }, fetcher),
    ).rejects.toThrow("SHA-256 mismatch");
  });

  it("validates every redirect before making the next request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/Auldric.dmg" },
      }),
    );
    await expect(
      verifyReleaseArtifacts({ schemaVersion: 1, artifacts: [artifact] }, fetcher),
    ).rejects.toThrow("redirected outside HTTPS GitHub release storage");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("follows a bounded HTTPS redirect through GitHub release storage", async () => {
    const redirectedUrl = "https://release-assets.githubusercontent.com/auldric/verified";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: redirectedUrl } }),
      )
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    await expect(
      verifyReleaseArtifacts({ schemaVersion: 1, artifacts: [artifact] }, fetcher),
    ).resolves.toBe(1);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL(redirectedUrl),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects downgrade, credential, port, and unbounded redirect chains before fetching them", async () => {
    for (const location of [
      "http://release-assets.githubusercontent.com/auldric/verified",
      "https://user:secret@release-assets.githubusercontent.com/auldric/verified",
      "https://release-assets.githubusercontent.com:444/auldric/verified",
      "https://githubusercontent.com.evil.example/auldric/verified",
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      await expect(
        verifyReleaseArtifacts({ schemaVersion: 1, artifacts: [artifact] }, fetcher),
        location,
      ).rejects.toThrow("redirected outside HTTPS GitHub release storage");
      expect(fetcher, location).toHaveBeenCalledTimes(1);
    }

    const loopingFetcher = vi.fn<typeof fetch>().mockImplementation(
      async (input) =>
        new Response(null, {
          status: 302,
          headers: { location: String(input) },
        }),
    );
    await expect(
      verifyReleaseArtifacts({ schemaVersion: 1, artifacts: [artifact] }, loopingFetcher),
    ).rejects.toThrow("exceeded 5 redirects");
    expect(loopingFetcher).toHaveBeenCalledTimes(6);
  });

  it("rejects failures and deceptive release locations", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      verifyReleaseArtifacts({ schemaVersion: 1, artifacts: [artifact] }, fetcher),
    ).rejects.toThrow("HTTP 404");

    for (const url of [
      artifact.url.replace("github.com", "github.com.evil.example"),
      artifact.url.replace("AuldricAI/auldrics", "AuldricAI/Auldric"),
      `${artifact.url}?redirect=https://evil.example`,
      `${artifact.url}#asset`,
      artifact.url.replace("github.com", "github.com:444"),
      `https://github.com@evil.example${new URL(artifact.url).pathname}`,
    ]) {
      expect(() =>
        decodeReleaseManifest({
          schemaVersion: 1,
          artifacts: [{ ...artifact, url }],
        }),
      ).toThrow("exact Auldric GitHub release path");
    }
  });

  it("rejects duplicate ids and mismatched filenames before fetching", () => {
    expect(() =>
      decodeReleaseManifest({
        schemaVersion: 1,
        artifacts: [artifact, artifact],
      }),
    ).toThrow("invalid or duplicate id");

    expect(() =>
      decodeReleaseManifest({
        schemaVersion: 1,
        artifacts: [{ ...artifact, fileName: "wrong.dmg" }],
      }),
    ).toThrow("filename does not match");

    expect(() =>
      decodeReleaseManifest({
        schemaVersion: 1,
        artifacts: [
          {
            ...artifact,
            url: artifact.url.replace("/v1.2.3/", "/v9.9.9/"),
          },
        ],
      }),
    ).toThrow("release tag does not match its version");
  });
});
