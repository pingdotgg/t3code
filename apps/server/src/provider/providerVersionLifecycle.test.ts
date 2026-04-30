import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  createProviderVersionAdvisory,
  getProviderVersionLifecycle,
} from "./providerVersionLifecycle.ts";

const driver = (value: string) => ProviderDriverKind.make(value);

describe("providerVersionLifecycle", () => {
  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("codex"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("codex"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it("marks installed providers behind latest when a newer provider version is available", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("claudeAgent"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "2.1.110",
      latestVersion: "2.1.117",
      updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("keeps update commands owned by provider lifecycle metadata", () => {
    expect(getProviderVersionLifecycle(driver("cursor"))).toEqual({
      provider: driver("cursor"),
      packageName: null,
      updateCommand: "agent update",
      updateExecutable: "agent",
      updateArgs: ["update"],
      updateLockKey: "cursor-agent",
    });
  });
});
