import type { EditorId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { editorLabel, editorMenu } from "./editorChoice";

const AVAILABLE: ReadonlyArray<EditorId> = ["cursor", "vscode", "zed", "file-manager"];

describe("editorMenu", () => {
  it("Given a stored pick that is available, when the menu is ordered, then it is first and the rest keep the server's order", () => {
    expect(editorMenu(AVAILABLE, "zed")).toEqual(["zed", "cursor", "vscode", "file-manager"]);
  });

  it("Given the stored pick is already first, when the menu is ordered, then the order is unchanged", () => {
    expect(editorMenu(AVAILABLE, "cursor")).toEqual(["cursor", "vscode", "zed", "file-manager"]);
  });

  it("Given a stored pick that is no longer available, when the menu is ordered, then the server's order is kept", () => {
    expect(editorMenu(AVAILABLE, "webstorm")).toEqual(["cursor", "vscode", "zed", "file-manager"]);
  });

  it("Given no stored pick, when the menu is ordered, then the server's order is kept", () => {
    expect(editorMenu(AVAILABLE, null)).toEqual(["cursor", "vscode", "zed", "file-manager"]);
  });

  it("Given no available editors, when the menu is ordered, then it is empty", () => {
    expect(editorMenu([], "zed")).toEqual([]);
  });
});

describe("editorLabel", () => {
  it.each([
    ["vscode", "VS Code"],
    ["cursor", "Cursor"],
    ["zed", "Zed"],
  ] as const)("Given %s, when it is labelled, then the label is %s", (id, label) => {
    expect(editorLabel(id)).toBe(label);
  });
});
