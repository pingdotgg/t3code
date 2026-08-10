import { describe, expect, it } from "vite-plus/test";

import {
  type PublicEnvironment,
  type ReleaseArtifact,
  type ReleaseManifest,
  resolvePublicCapabilities,
} from "./capabilities";

const publicationEnvironment = {
  PUBLIC_AULDRIC_SITE_URL: "https://auldric.com",
  PUBLIC_AULDRIC_LEGAL_NAME: "Auldric Test Operator",
  PUBLIC_AULDRIC_PRIVACY_CONTACT: "privacy@auldric.com",
  PUBLIC_AULDRIC_LEGAL_ADDRESS: "1 Example Street, London, SW1A 1AA, United Kingdom",
  PUBLIC_AULDRIC_LEGAL_JURISDICTION: "England and Wales",
  PUBLIC_AULDRIC_WAITLIST_RETENTION_DAYS: "180",
} as const satisfies PublicEnvironment;

const releaseArtifact = {
  id: "desktop-macos-arm64-v1.2.3",
  url: "https://github.com/AuldricAI/auldrics/releases/download/v1.2.3/Auldric-1.2.3-arm64.dmg",
  fileName: "Auldric-1.2.3-arm64.dmg",
  platform: "macos-apple-silicon",
  version: "1.2.3",
  sha256: "a".repeat(64),
} as const satisfies ReleaseArtifact;

function releaseManifest(artifact: ReleaseArtifact = releaseArtifact): ReleaseManifest {
  return { schemaVersion: 1, artifacts: [artifact] };
}

describe("Auldric public capabilities", () => {
  it("fails closed when publication and product inputs are absent", () => {
    expect(resolvePublicCapabilities({})).toEqual({
      canonicalUrl: "https://auldric.com",
      legal: { publicationReady: false },
      access: { kind: "unavailable" },
      waitlist: { kind: "closed" },
      download: { kind: "unavailable" },
      primaryAction: {
        kind: "status",
        href: "/access",
        label: "Check availability",
      },
    });
  });

  it("requires exact publication identity before allowing indexing or collection", () => {
    expect(resolvePublicCapabilities(publicationEnvironment).legal).toEqual({
      name: "Auldric Test Operator",
      privacyContact: "privacy@auldric.com",
      postalAddress: "1 Example Street, London, SW1A 1AA, United Kingdom",
      jurisdiction: "England and Wales",
      waitlistRetentionDays: 180,
      publicationReady: true,
    });

    for (const siteUrl of [
      undefined,
      "http://auldric.com",
      "https://auldric.com/legal",
      "https://auldric.com?preview=1",
      "https://auldric.com#preview",
      "https://auldric.com.evil.example",
      "https://evil-auldric.com",
      "https://auldric.com@evil.example",
    ]) {
      expect(
        resolvePublicCapabilities({
          ...publicationEnvironment,
          PUBLIC_AULDRIC_SITE_URL: siteUrl,
        }).legal.publicationReady,
      ).toBe(false);
    }

    for (const missingLegalInput of [
      { PUBLIC_AULDRIC_LEGAL_NAME: undefined },
      { PUBLIC_AULDRIC_PRIVACY_CONTACT: undefined },
      { PUBLIC_AULDRIC_LEGAL_ADDRESS: undefined },
      { PUBLIC_AULDRIC_LEGAL_JURISDICTION: undefined },
    ]) {
      expect(
        resolvePublicCapabilities({
          ...publicationEnvironment,
          ...missingLegalInput,
        }).legal.publicationReady,
      ).toBe(false);
    }
  });

  it("enables access only at a separate Auldric origin", () => {
    const enabled = resolvePublicCapabilities({
      ...publicationEnvironment,
      PUBLIC_AULDRIC_ACCESS_STATUS: "available",
      PUBLIC_AULDRIC_ACCESS_URL: "https://app.auldric.com/start",
    });
    expect(enabled.access).toEqual({
      kind: "available",
      url: "https://app.auldric.com/start",
    });
    expect(enabled.primaryAction).toEqual({
      kind: "access",
      href: "https://app.auldric.com/start",
      label: "Open Auldric",
    });
    expect(
      resolvePublicCapabilities({
        PUBLIC_AULDRIC_ACCESS_STATUS: "available",
        PUBLIC_AULDRIC_ACCESS_URL: "https://app.auldric.com/start",
      }).access,
    ).toEqual({ kind: "unavailable" });

    for (const accessUrl of [
      undefined,
      "http://app.auldric.com",
      "https://auldric.com",
      "https://auldric.com/app",
      "https://auldric.com.evil.example",
      "https://evil-auldric.com",
      "https://auldric.com@evil.example",
      "https://app.auldric.com.evil.example",
      "https://app.auldric.com/start?redirect=https://evil.example",
      "https://app.auldric.com/start#redirect",
      "https://app.auldric.com/%2e%2e/settings",
      "https://app.auldric.com/%2f%2fevil.example",
      "https://app.auldric.com//evil.example",
      "//app.auldric.com",
    ]) {
      expect(
        resolvePublicCapabilities({
          ...publicationEnvironment,
          PUBLIC_AULDRIC_ACCESS_STATUS: "available",
          PUBLIC_AULDRIC_ACCESS_URL: accessUrl,
        }).access,
      ).toEqual({ kind: "unavailable" });
    }
  });

  it("opens the waitlist only with complete legal, retention, endpoint, and consent inputs", () => {
    const open = resolvePublicCapabilities({
      ...publicationEnvironment,
      PUBLIC_AULDRIC_WAITLIST_STATUS: "open",
      PUBLIC_AULDRIC_WAITLIST_ENDPOINT: "https://forms.example.com/auldric/waitlist",
    });
    expect(open.waitlist).toEqual({
      kind: "open",
      endpoint: "https://forms.example.com/auldric/waitlist",
      controller: "Auldric Test Operator",
      privacyContact: "privacy@auldric.com",
      retentionDays: 180,
    });
    expect(open.primaryAction.kind).toBe("waitlist");

    for (const partial of [
      { PUBLIC_AULDRIC_SITE_URL: undefined },
      { PUBLIC_AULDRIC_LEGAL_NAME: undefined },
      { PUBLIC_AULDRIC_PRIVACY_CONTACT: undefined },
      { PUBLIC_AULDRIC_LEGAL_ADDRESS: undefined },
      { PUBLIC_AULDRIC_LEGAL_JURISDICTION: undefined },
      { PUBLIC_AULDRIC_WAITLIST_RETENTION_DAYS: undefined },
      { PUBLIC_AULDRIC_WAITLIST_RETENTION_DAYS: "0" },
      { PUBLIC_AULDRIC_WAITLIST_RETENTION_DAYS: "731" },
      { PUBLIC_AULDRIC_WAITLIST_ENDPOINT: undefined },
      { PUBLIC_AULDRIC_WAITLIST_ENDPOINT: "http://forms.example.com/waitlist" },
      { PUBLIC_AULDRIC_WAITLIST_ENDPOINT: "https://auldric.com/waitlist" },
      { PUBLIC_AULDRIC_WAITLIST_ENDPOINT: "https://forms.example.com/waitlist?token=secret" },
      { PUBLIC_AULDRIC_WAITLIST_ENDPOINT: "https://forms.example.com/waitlist#form" },
      { PUBLIC_AULDRIC_WAITLIST_STATUS: "enabled" },
    ]) {
      expect(
        resolvePublicCapabilities({
          ...publicationEnvironment,
          PUBLIC_AULDRIC_WAITLIST_STATUS: "open",
          PUBLIC_AULDRIC_WAITLIST_ENDPOINT: "https://forms.example.com/auldric/waitlist",
          ...partial,
        }).waitlist,
      ).toEqual({ kind: "closed" });
    }
  });

  it("does not mistake operator-entered release metadata for a verified download", () => {
    const unverified = resolvePublicCapabilities({
      PUBLIC_AULDRIC_DOWNLOAD_STATUS: "available",
      PUBLIC_AULDRIC_DOWNLOAD_ARTIFACT_ID: releaseArtifact.id,
      PUBLIC_AULDRIC_DOWNLOAD_URL: releaseArtifact.url,
      PUBLIC_AULDRIC_DOWNLOAD_FILE_NAME: releaseArtifact.fileName,
      PUBLIC_AULDRIC_DOWNLOAD_PLATFORM: releaseArtifact.platform,
      PUBLIC_AULDRIC_DOWNLOAD_VERSION: releaseArtifact.version,
      PUBLIC_AULDRIC_DOWNLOAD_SHA256: releaseArtifact.sha256,
    });
    expect(unverified.download).toEqual({ kind: "unavailable" });
  });

  it("exposes only a selected artifact from the committed verified-release manifest", () => {
    const enabled = resolvePublicCapabilities(
      {
        ...publicationEnvironment,
        PUBLIC_AULDRIC_DOWNLOAD_STATUS: "available",
        PUBLIC_AULDRIC_DOWNLOAD_ARTIFACT_ID: releaseArtifact.id,
      },
      releaseManifest(),
    );
    expect(enabled.download).toEqual({
      kind: "available",
      url: releaseArtifact.url,
      fileName: releaseArtifact.fileName,
      platform: "macOS · Apple silicon",
      version: "1.2.3",
      sha256: releaseArtifact.sha256,
    });
    expect(
      resolvePublicCapabilities(
        {
          PUBLIC_AULDRIC_DOWNLOAD_STATUS: "available",
          PUBLIC_AULDRIC_DOWNLOAD_ARTIFACT_ID: releaseArtifact.id,
        },
        releaseManifest(),
      ).download,
    ).toEqual({ kind: "unavailable" });

    expect(
      resolvePublicCapabilities(
        {
          ...publicationEnvironment,
          PUBLIC_AULDRIC_DOWNLOAD_STATUS: "available",
          PUBLIC_AULDRIC_DOWNLOAD_ARTIFACT_ID: "not-recorded",
        },
        releaseManifest(),
      ).download,
    ).toEqual({ kind: "unavailable" });
  });

  it("rejects release host, path, redirect, filename, version, platform, and digest tricks", () => {
    const invalidArtifacts: ReadonlyArray<ReleaseArtifact> = [
      { ...releaseArtifact, url: releaseArtifact.url.replace("github.com", "github.com.evil") },
      {
        ...releaseArtifact,
        url: releaseArtifact.url.replace("AuldricAI/auldrics", "AuldricAI/Auldric"),
      },
      { ...releaseArtifact, url: `${releaseArtifact.url}?redirect=https://evil.example` },
      { ...releaseArtifact, url: `${releaseArtifact.url}#download` },
      {
        ...releaseArtifact,
        url: releaseArtifact.url.replace("/Auldric-1.2.3", "/nested/Auldric-1.2.3"),
      },
      { ...releaseArtifact, fileName: "another-file.dmg" },
      { ...releaseArtifact, version: "latest" },
      { ...releaseArtifact, platform: "ios" as ReleaseArtifact["platform"] },
      { ...releaseArtifact, sha256: "not-a-digest" },
    ];

    for (const artifact of invalidArtifacts) {
      expect(
        resolvePublicCapabilities(
          {
            ...publicationEnvironment,
            PUBLIC_AULDRIC_DOWNLOAD_STATUS: "available",
            PUBLIC_AULDRIC_DOWNLOAD_ARTIFACT_ID: artifact.id,
          },
          releaseManifest(artifact),
        ).download,
      ).toEqual({ kind: "unavailable" });
    }
  });
});
