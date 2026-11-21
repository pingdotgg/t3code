import { describe, expect, it } from "vite-plus/test";

import { renameForkPath, renameForkText } from "./forkRenameCodemod.ts";

const rename = (path: string, text: string) => renameForkText(path, text).text;

describe("renameForkText", () => {
  it.each<readonly [string, string, string]>([
    [
      "apps/web/src/a.ts",
      'import { X } from "@t3tools/contracts";',
      'import { X } from "@lathe/contracts";',
    ],
    [
      "apps/marketing/src/pages/schema/t3.json.ts",
      'import { schema } from "@t3tools/shared/t3ProjectFile";',
      'import { schema } from "@lathe/shared/latheProjectFile";',
    ],
    [
      "apps/web/src/a.tsx",
      "export function T3ComposerEditorView() {}",
      "export function LatheComposerEditorView() {}",
    ],
    [
      "apps/web/src/a.ts",
      "const t3Home = resolveT3Home();",
      "const latheHome = resolveLatheHome();",
    ],
    [
      "apps/web/src/a.ts",
      'const message = "Restart T3 Code?";',
      'const message = "Restart Lathe?";',
    ],
    [
      "apps/web/src/components/mcp/mcpApps.ts",
      "`https://poke.com/integrations/new?name=T3%20Code&url=${url}`",
      "`https://poke.com/integrations/new?name=Lathe&url=${url}`",
    ],
    [
      "apps/server/src/cli/config.ts",
      'Config.String("T3CODE_HOME")',
      'Config.String("LATHE_HOME")',
    ],
    ["apps/server/src/x.ts", "const url = env.T3_MCP_URL;", "const url = env.LATHE_MCP_URL;"],
    [
      "packages/client-runtime/src/authorization/remote.test.ts",
      '"&client_label=T3+Code+Mobile&client_device_type=mobile"',
      '"&client_label=Lathe+Mobile&client_device_type=mobile"',
    ],
    [
      "apps/mobile/src/a.test.ts",
      'expect(filterProjectScopes(scopes, "  T3 CODE ")).toEqual([code]);',
      'expect(filterProjectScopes(scopes, "  LATHE ")).toEqual([code]);',
    ],
    ["apps/server/src/x.ts", '"mcp__t3-code__t3_thread_list",', '"mcp__lathe__lathe_thread_list",'],
    [
      "packages/shared/src/t3McpToolPresentation.ts",
      'const T3_MCP_SERVER_ALIASES = new Set([\n  "t3-code",\n  "t3_code",\n  "t3code",\n]);',
      'const LATHE_MCP_SERVER_ALIASES = new Set([\n  "lathe",\n  "t3-code",\n  "t3_code",\n  "t3code",\n]);',
    ],
    [
      "packages/shared/src/assistantCitations.ts",
      'const CITATION_PROTOCOL = "t3-citation:";',
      'const CITATION_PROTOCOL = "lathe-citation:";',
    ],
    ["docs/user/install.md", "Run `t3 serve` to start.", "Run `lathe serve` to start."],
    ["docs/user/install.md", "Or run `npx t3` once.", "Or run `npx @jamesainslie/lathe` once."],
    [
      "apps/server/src/cli/update.ts",
      "`Updated to t3@${version}.`",
      "`Updated to @jamesainslie/lathe@${version}.`",
    ],
    [
      "apps/web/src/i18n/translations/sv.json",
      '"x": "Skapar T3-trådar och T3:s systemavtryck",',
      '"x": "Skapar Lathe-trådar och Lathe:s systemavtryck",',
    ],
  ])("renames %s: %s", (path, input, expected) => {
    expect(rename(path, input)).toBe(expected);
  });

  it.each<readonly [string, string]>([
    ["apps/server/src/x.ts", 'headers["x-t3-relay-delivery-id"]'],
    [
      "packages/contracts/src/t3ProjectFile.ts",
      'const schema = "https://t3.codes/schema/t3.json";',
    ],
    ["README.md", "Fork of https://github.com/pingdotgg/t3code"],
    ["packages/shared/src/imageDimensions.ts", "const n = data.getUint32(0);"],
    ["packages/shared/src/forkLegacyEnv.ts", 'const LEGACY_PREFIX = "T3CODE_";'],
    ["apps/web/src/i18n/translations/de.json", '"x": "Dein T3-Connect-Konto und T3-Chat-Abo",'],
  ])("leaves kept, wire, upstream and false-positive names alone: %s", (path, input) => {
    expect(rename(path, input)).toBe(input);
  });

  it.each<readonly [string, string]>([
    [
      "  const prefixed = /^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);",
      "  const prefixed = /^(?:mcp[-_]{1,2})?(?:lathe|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);",
    ],
    [
      "  const match = /^(?<server>t3-code|t3_code|t3code)(?:[.:/])(?<tool>.+)$/i.exec(label);",
      "  const match = /^(?<server>lathe|t3-code|t3_code|t3code)(?:[.:/])(?<tool>.+)$/i.exec(label);",
    ],
    [
      'const T3_MCP_SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code"]);',
      'const LATHE_MCP_SERVER_ALIASES = new Set(["lathe", "t3-code", "t3_code", "t3code"]);',
    ],
    [
      "      /^editor_t3_?code_[0-9a-f]{8}$/.test(qualified[1]) &&",
      "      /^editor_(?:lathe|t3_?code)_[0-9a-f]{8}$/.test(qualified[1]) &&",
    ],
  ])("widens an MCP name matcher to accept lathe: %s", (input, expected) => {
    const once = rename("packages/shared/src/t3McpToolPresentation.ts", input);
    expect(once).toBe(expected);
    expect(rename("packages/shared/src/latheMcpToolPresentation.ts", once)).toBe(once);
  });

  it("is idempotent", () => {
    const once = rename("apps/web/src/a.ts", 'import { T3Xyz } from "@t3tools/shared"; // T3 Code');
    expect(rename("apps/web/src/a.ts", once)).toBe(once);
  });

  it("refuses text with an unclassified occurrence", () => {
    expect(() => renameForkText("apps/server/src/x.ts", 'const NEW_NAME = "t3wombat";')).toThrow(
      /t3wombat/,
    );
  });
});

describe("renameForkPath", () => {
  it.each<readonly [string, string]>([
    // Mobile keeps upstream's names until its own rename project.
    ["apps/mobile/modules/t3-terminal/index.ts", "apps/mobile/modules/t3-terminal/index.ts"],
    [
      "oxlint-plugin-t3code/rules/no-test-in-loop.ts",
      "oxlint-plugin-lathe/rules/no-test-in-loop.ts",
    ],
    [
      "packages/shared/src/t3McpToolPresentation.ts",
      "packages/shared/src/latheMcpToolPresentation.ts",
    ],
    ["apps/web/src/components/T3Wordmark.tsx", "apps/web/src/components/LatheWordmark.tsx"],
    ["packaging/aur/t3code-bin/PKGBUILD", "packaging/aur/t3code-bin/PKGBUILD"],
    // prove-scenario.ts finds iOS scenarios by this module's name, which renames with it.
    ["scripts/scenarios/t3-mobile.ts", "scripts/scenarios/lathe-mobile.ts"],
  ])("renames %s", (path, expected) => {
    expect(renameForkPath(path)).toBe(expected);
  });
});
