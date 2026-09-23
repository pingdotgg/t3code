import { describe, expect, it } from "vite-plus/test";

import { parseExtensionReference } from "./extensionReference";

describe("parseExtensionReference", () => {
  it.each([
    ["esbenp.prettier-vscode", { namespace: "esbenp", name: "prettier-vscode" }],
    [
      "  ms-python.python@2024.2.1 ",
      { namespace: "ms-python", name: "python", version: "2024.2.1" },
    ],
    [
      "https://open-vsx.org/extension/redhat/vscode-yaml",
      { namespace: "redhat", name: "vscode-yaml" },
    ],
    [
      "https://open-vsx.org/extension/redhat/vscode-yaml/1.15.0",
      { namespace: "redhat", name: "vscode-yaml", version: "1.15.0" },
    ],
    ["vscode:extension/dbaeumer.vscode-eslint", { namespace: "dbaeumer", name: "vscode-eslint" }],
    [
      "https://marketplace.visualstudio.com/items?itemName=golang.Go",
      { namespace: "golang", name: "Go" },
    ],
  ])("parses %s", (input, expected) => {
    expect(parseExtensionReference(input)).toEqual({ type: "openVsx", ...expected });
  });

  it.each([
    "",
    "prettier",
    "pub.name@",
    "pub.name@1.0/2",
    "https://example.com/extension/pub/name",
    "https://open-vsx.org/namespace/pub",
    "https://open-vsx.org/extension/pub",
    "https://marketplace.visualstudio.com/items?itemName=nodot",
    "vscode:extension/",
    "https://open-vsx.org/extension/-bad/name",
    "https://open-vsx.org/extension/pub/%E0%A4%A",
  ])("rejects %s", (input) => {
    expect(parseExtensionReference(input)).toBeNull();
  });
});
