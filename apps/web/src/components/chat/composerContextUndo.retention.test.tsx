// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import { type RetainedContextPayloads, useRetainedContextPayloads } from "./composerContextUndo";

const file = {
  type: "file",
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  file: new File(["notes"], "notes.txt", { type: "text/plain" }),
} satisfies ComposerFileAttachment;

let container: HTMLDivElement;
let root: Root;
let current: RetainedContextPayloads;

function Probe({ targetKey }: { targetKey: string }) {
  const retained = useRetainedContextPayloads(targetKey);
  useEffect(() => {
    current = retained;
  });
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

it("keeps deleted payloads for the open draft and releases them when the draft changes", () => {
  act(() => root.render(<Probe targetKey="thread-a" />));
  const retained = current;
  retained.files.set("file:file-1", file);

  act(() => root.render(<Probe targetKey="thread-a" />));
  expect(current.files.get("file:file-1")).toBe(file);

  act(() => root.render(<Probe targetKey="thread-b" />));
  expect(retained.files.size).toBe(0);
  expect(current.files.size).toBe(0);
});

it("releases deleted payloads when the composer unmounts", () => {
  act(() => root.render(<Probe targetKey="thread-a" />));
  const retained = current;
  retained.files.set("file:file-1", file);

  act(() => root.unmount());
  expect(retained.files.size).toBe(0);
  root = createRoot(container);
});
