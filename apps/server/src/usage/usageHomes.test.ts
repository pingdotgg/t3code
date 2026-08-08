import { describe, expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { listProviderHomeCandidates } from "./usageHomes.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("listProviderHomeCandidates", () => {
  it("falls back to the legacy provider blob when no instance claims the default slot", () => {
    const settings = decodeServerSettings({
      providers: { codex: { homePath: "~/.codex-legacy" } },
    });

    const codex = listProviderHomeCandidates(settings, "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({ homePath: "~/.codex-legacy" });

    const claude = listProviderHomeCandidates(settings, "claude");
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({ homePath: "" });
  });

  it("prefers an explicit default-slot instance over the legacy blob", () => {
    const settings = decodeServerSettings({
      providers: { codex: { homePath: "~/.codex-legacy" } },
      providerInstances: {
        codex: { driver: "codex", config: { homePath: "~/.codex-t3/work" } },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({ homePath: "~/.codex-t3/work" });
  });

  it("returns every instance of the driver and ignores other drivers", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        codex: { driver: "codex", config: { homePath: "~/.codex-t3/work" } },
        codex_personal: { driver: "codex", config: { homePath: "~/.codex-t3/personal" } },
        codex_work_overlay: {
          driver: "codex",
          config: { homePath: "~/.codex-t3/work", shadowHomePath: "~/.codex-t3/overlay" },
        },
        cursor: { driver: "cursor", config: { binaryPath: "cursor-agent" } },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex");
    expect(codex).toHaveLength(3);
    expect(codex.map((config) => (config as { homePath?: string }).homePath)).toEqual([
      "~/.codex-t3/work",
      "~/.codex-t3/personal",
      "~/.codex-t3/work",
    ]);

    // No explicit claudeAgent instance: the legacy default still applies.
    expect(listProviderHomeCandidates(settings, "claude")).toHaveLength(1);
  });

  it("treats an instance without a config payload as driver defaults", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        codex_extra: { driver: "codex" },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex");
    // The config-less instance plus the legacy default slot.
    expect(codex).toHaveLength(2);
    expect(codex[0]).toEqual({});
  });
});
