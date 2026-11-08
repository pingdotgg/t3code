import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EDITORS, EditorId } from "./editor.ts";

const decodeEditorId = Schema.decodeUnknownSync(EditorId);

describe("editor targets", () => {
  it("accepts IntelliJ IDEA and Ghostty ids", () => {
    expect(decodeEditorId("idea")).toBe("idea");
    expect(decodeEditorId("ghostty")).toBe("ghostty");
  });

  it("classifies Ghostty as a project-only target", () => {
    const ghostty = EDITORS.find((editor) => editor.id === "ghostty");
    const idea = EDITORS.find((editor) => editor.id === "idea");

    expect(ghostty).toMatchObject({
      canOpenFiles: false,
      canOpenDirectories: true,
      showInProjectPicker: true,
    });
    expect(idea).toMatchObject({
      canOpenFiles: true,
      canOpenDirectories: true,
      showInProjectPicker: true,
    });
  });
});
