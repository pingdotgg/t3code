import { describe, expect, it } from "vite-plus/test";

import {
  readAloudBaseUrl,
  readAloudVoiceLabel,
  resolveReadAloudServerUrl,
  sortReadAloudVoices,
} from "./readAloudServer";

describe("resolveReadAloudServerUrl", () => {
  it("uses the paired PC's host on the read-aloud port", () => {
    expect(resolveReadAloudServerUrl("http://100.64.0.10:3773/", "")).toBe(
      "http://100.64.0.10:3776",
    );
    expect(resolveReadAloudServerUrl("https://pc.example.ts.net", "")).toBe(
      "http://pc.example.ts.net:3776",
    );
  });

  it("only uses direct connections to the PC", () => {
    expect(readAloudBaseUrl("BearerConnectionTarget", "http://100.64.0.10:3773")).toBe(
      "http://100.64.0.10:3773",
    );
    expect(readAloudBaseUrl("PrimaryConnectionTarget", "http://127.0.0.1:3773")).toBe(
      "http://127.0.0.1:3773",
    );
    expect(readAloudBaseUrl("RelayConnectionTarget", "https://relay.example")).toBeNull();
    expect(readAloudBaseUrl("SshConnectionTarget", "http://127.0.0.1:41000")).toBeNull();
  });

  it("keeps IPv6 hosts valid", () => {
    expect(resolveReadAloudServerUrl("http://[fd7a:115c:a1e0::1]:3773", "")).toBe(
      "http://[fd7a:115c:a1e0::1]:3776",
    );
  });

  it("prefers the build-time override", () => {
    expect(resolveReadAloudServerUrl("http://100.64.0.10:3773", " http://other:9/ ")).toBe(
      "http://other:9",
    );
  });

  it("returns null without a usable connection", () => {
    expect(resolveReadAloudServerUrl(null, "")).toBeNull();
    expect(resolveReadAloudServerUrl("not a url", "")).toBeNull();
  });
});

describe("voices", () => {
  it("labels voices like the desktop picker", () => {
    expect(readAloudVoiceLabel("en-US-AvaMultilingualNeural")).toBe("Ava (Multilingual) · US");
    expect(readAloudVoiceLabel("en-GB-SoniaNeural")).toBe("Sonia · GB");
  });

  it("keeps English voices, US first", () => {
    const sorted = sortReadAloudVoices([
      { shortName: "en-GB-SoniaNeural", gender: "Female", personalities: "" },
      { shortName: "fr-FR-DeniseNeural", gender: "Female", personalities: "" },
      { shortName: "en-US-AvaNeural", gender: "Female", personalities: "" },
    ]);
    expect(sorted.map((voice) => voice.shortName)).toEqual([
      "en-US-AvaNeural",
      "en-GB-SoniaNeural",
    ]);
  });
});
