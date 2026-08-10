import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AcpRegistryIndex } from "@t3tools/contracts";

import {
  catalogEntryFromRegistryAgent,
  featuredCatalogEntries,
  mergeAcpRegistryCatalog,
} from "./AcpRegistryCatalog.ts";

const decodeIndex = Schema.decodeUnknownSync(AcpRegistryIndex);

describe("featuredCatalogEntries", () => {
  it("includes Gemini, Copilot, Pi, and custom ACP", () => {
    expect(featuredCatalogEntries().map((agent) => agent.id)).toEqual(
      expect.arrayContaining(["gemini", "github-copilot-cli", "pi-acp", "custom"]),
    );
    expect(featuredCatalogEntries().find((agent) => agent.id === "gemini")?.launch).toEqual({
      command: "gemini",
      args: ["--acp"],
    });
    expect(featuredCatalogEntries().find((agent) => agent.id === "custom")?.launch).toBeNull();
  });
});

describe("catalogEntryFromRegistryAgent", () => {
  it("prefers featured launch specs over live registry npx wrappers", () => {
    const entry = catalogEntryFromRegistryAgent({
      id: "gemini",
      name: "Gemini CLI",
      version: "0.54.4",
      description: "Google's official CLI for Gemini",
      distribution: {
        npx: { package: "@google/gemini-cli@0.54.4", args: ["--acp"] },
      },
    });

    expect(entry.featured).toBe(true);
    expect(entry.launch).toEqual({ command: "gemini", args: ["--acp"] });
    expect(entry.version).toBe("0.54.4");
  });

  it("maps npx-only registry agents without downloading binaries", () => {
    const entry = catalogEntryFromRegistryAgent({
      id: "some-new-agent",
      name: "Some New Agent",
      description: "A new ACP agent",
      distribution: {
        npx: { package: "@example/some-agent", args: ["--acp"] },
      },
    });

    expect(entry.featured).toBe(false);
    expect(entry.distributionType).toBe("npx");
    expect(entry.launch).toEqual({
      command: "npx",
      args: ["-y", "@example/some-agent", "--acp"],
    });
  });

  it("marks binary-only registry agents as unsupported", () => {
    const entry = catalogEntryFromRegistryAgent({
      id: "binary-only",
      name: "Binary Only",
      distribution: {
        binary: { darwin: "https://example.com/agent" },
      },
    });

    expect(entry.distributionType).toBe("unsupported");
    expect(entry.launch).toBeNull();
  });
});

describe("mergeAcpRegistryCatalog", () => {
  it("returns featured agents when the live index is unavailable", () => {
    const featured = featuredCatalogEntries();
    expect(mergeAcpRegistryCatalog(featured, null).agents).toEqual(featured);
  });

  it("appends non-featured live registry agents after featured rows", () => {
    const featured = featuredCatalogEntries();
    const index = decodeIndex({
      version: "1.0.0",
      agents: [
        {
          id: "gemini",
          name: "Gemini CLI",
          version: "0.54.4",
          distribution: {
            npx: { package: "@google/gemini-cli@0.54.4", args: ["--acp"] },
          },
        },
        {
          id: "fresh-agent",
          name: "Fresh Agent",
          distribution: {
            uvx: { package: "fresh-agent", args: ["acp"] },
          },
        },
      ],
    });

    const merged = mergeAcpRegistryCatalog(featured, index);
    expect(merged.registryVersion).toBe("1.0.0");
    expect(merged.agents[0]?.id).toBe("gemini");
    expect(merged.agents[0]?.featured).toBe(true);
    expect(merged.agents.find((agent) => agent.id === "fresh-agent")).toMatchObject({
      featured: false,
      distributionType: "uvx",
      launch: { command: "uvx", args: ["fresh-agent", "acp"] },
    });
  });
});
