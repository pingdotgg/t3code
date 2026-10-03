import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sandboxProviderHomes } from "./SandboxService.ts";

describe("sandboxProviderHomes", () => {
  it("collects Claude and Codex homes from providers, instances, and their env", () => {
    const homes = sandboxProviderHomes({
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: "/homes/codex" },
      },
      providerInstances: {
        [ProviderInstanceId.make("codex-work")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: "/homes/codex-work", shadowHomePath: "/homes/codex-work-shadow" },
        },
        [ProviderInstanceId.make("claude-work")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [
            { name: "CLAUDE_CONFIG_DIR", value: "/homes/claude-work", sensitive: false },
          ],
        },
        [ProviderInstanceId.make("other")]: {
          driver: ProviderDriverKind.make("opencode"),
          config: { homePath: "/homes/opencode" },
        },
      },
    });
    expect(homes).toEqual([
      "/homes/codex",
      "/homes/codex-work",
      "/homes/codex-work-shadow",
      "/homes/claude-work",
    ]);
  });
});
