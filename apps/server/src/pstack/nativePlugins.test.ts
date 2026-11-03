import { describe, expect, it } from "@effect/vitest";

import { claudePstackPluginOverrides, codexPstackPluginOverrideArgs } from "./nativePlugins.ts";

describe("native pstack plugins", () => {
  it("disables every addressable Codex pstack plugin and nothing else", () => {
    const config = [
      '[plugins."pstack@pstack-codex"]',
      "enabled = true",
      '  [plugins."pstack@other"]',
      "enabled = false",
      '[plugins."pstack-extra@local"]',
      '[plugins."tracedecay@local"]',
      '[plugins."pstack@dotted.market"]',
      "[marketplaces.pstack-codex]",
    ].join("\n");
    expect(codexPstackPluginOverrideArgs(config)).toEqual([
      "-c",
      "plugins.pstack@pstack-codex.enabled=false",
      "-c",
      "plugins.pstack@other.enabled=false",
    ]);
    expect(codexPstackPluginOverrideArgs('[plugins."tracedecay@local"]\n')).toEqual([]);
    for (const config of [
      "[plugins.'pstack@local']\nenabled = true\n",
      'plugins."pstack@local".enabled = true\n',
      '[plugins]\n"pstack@local" = { enabled = true }\n',
      'plugins = { "pstack@local" = { enabled = true } }\n',
    ]) {
      expect(codexPstackPluginOverrideArgs(config)).toEqual([
        "-c",
        "plugins.pstack@local.enabled=false",
      ]);
    }
    expect(
      codexPstackPluginOverrideArgs('instructions = """\n[plugins."pstack@fake"]\n"""\n'),
    ).toEqual([]);
    expect(codexPstackPluginOverrideArgs('[plugins."pstack@broken"')).toEqual([]);
  });

  it("disables only Claude pstack plugins that settings enable", () => {
    expect(
      claudePstackPluginOverrides(
        new Map([
          ["pstack@cursor-plugins", true],
          ["pstack@off", false],
          ["tracedecay@local", true],
        ]),
      ),
    ).toEqual({ "pstack@cursor-plugins": false });
    expect(claudePstackPluginOverrides(new Map([["tracedecay@local", true]]))).toBeUndefined();
  });
});
