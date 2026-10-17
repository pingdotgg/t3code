import type { ServerProviderSkill } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const babysit: ServerProviderSkill = {
  name: "babysit",
  path: "/skills/babysit/SKILL.md",
  enabled: true,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Composer({ skills }: { skills: ReadonlyArray<ServerProviderSkill> }) {
  const [prompt, setPrompt] = useState({ value: "$babysit now", cursor: 0 });
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={prompt.value}
      cursor={prompt.cursor}
      richTextEnabled
      contextRecords={new Map()}
      skills={skills}
      disabled={false}
      placeholder=""
      onChange={(value, cursor) => setPrompt({ value, cursor })}
      onPaste={() => {}}
    />
  );
}

function skillChipPositions(editor: Editor) {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "composer-skill") positions.push(pos);
  });
  return positions;
}

it("does not let undo restore a chip for a skill the provider no longer offers", async () => {
  await act(async () => root.render(<Composer skills={[babysit]} />));
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  const editor = element.editor;
  const [chip] = skillChipPositions(editor);
  if (chip === undefined) throw new Error("Known skill did not chip");

  await act(async () => {
    editor.commands.deleteRange({ from: chip, to: chip + 1 });
  });
  await act(async () => root.render(<Composer skills={[]} />));
  await act(async () => {
    editor.commands.undo();
  });

  expect(skillChipPositions(editor)).toEqual([]);
  expect(serializeEditorDoc(editor.state.doc).value).toBe("$babysit now");
});
