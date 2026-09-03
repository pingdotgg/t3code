import { describe, expect, it } from "vite-plus/test";

import {
  buildDevinProviderSnapshot,
  getDevinFallbackModels,
  parseDevinAuthStatusOutput,
  parseDevinVersionOutput,
  resolveDevinAcpBaseModelId,
} from "./DevinProvider.ts";

describe("parseDevinVersionOutput", () => {
  it("extracts the version from `devin --version` output", () => {
    expect(parseDevinVersionOutput("devin 3000.6.7 (260a97c8)\n")).toBe("3000.6.7");
  });

  it("returns null for unrecognized output", () => {
    expect(parseDevinVersionOutput("")).toBeNull();
    expect(parseDevinVersionOutput("something else")).toBeNull();
  });
});

describe("resolveDevinAcpBaseModelId", () => {
  it("falls back to adaptive for empty selections", () => {
    expect(resolveDevinAcpBaseModelId(null)).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("  ")).toBe("adaptive");
  });

  it("passes explicit slugs through untouched", () => {
    expect(resolveDevinAcpBaseModelId("glm-5-2")).toBe("glm-5-2");
  });
});

describe("parseDevinAuthStatusOutput", () => {
  it("reports authenticated when logged in", () => {
    const parsed = parseDevinAuthStatusOutput(
      { stdout: "Logged in (via Devin).\n", stderr: "", code: 0 },
      "3000.6.7",
    );
    expect(parsed.status).toBe("ready");
    expect(parsed.auth.status).toBe("authenticated");
    expect(parsed.version).toBe("3000.6.7");
  });

  it("reports unauthenticated when login is required", () => {
    const parsed = parseDevinAuthStatusOutput(
      { stdout: "Not logged in. Run `devin auth login`.\n", stderr: "", code: 1 },
      "3000.6.7",
    );
    expect(parsed.status).toBe("error");
    expect(parsed.auth.status).toBe("unauthenticated");
    expect(parsed.message).toContain("devin auth login");
  });
});

describe("getDevinFallbackModels", () => {
  it("offers the adaptive default plus custom models", () => {
    const models = getDevinFallbackModels({ customModels: ["my-model"] });
    expect(models.map((model) => model.slug)).toEqual(["adaptive", "my-model"]);
  });
});

describe("buildDevinProviderSnapshot", () => {
  it("downgrades ready to warning when discovery fails", () => {
    const snapshot = buildDevinProviderSnapshot({
      checkedAt: "2026-09-04T00:00:00.000Z",
      devinSettings: { enabled: true, binaryPath: "devin", customModels: [] },
      parsed: { version: "3000.6.7", status: "ready", auth: { status: "authenticated" } },
      discoveredModels: [],
      discoveryWarning: "Devin ACP model discovery failed.",
    });
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain("Devin ACP model discovery failed.");
  });
});
