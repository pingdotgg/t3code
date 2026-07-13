import { describe, expect, it } from "bun:test";
import { SyntaxStyle } from "@opentui/core";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { FlatTreeRow } from "../fileTree.ts";
import { FilesView, type ViewingFile } from "./FilesView.tsx";

const rows: ReadonlyArray<FlatTreeRow> = [
  { kind: "dir", name: "src", path: "src", depth: 0, additions: 0, deletions: 0, collapsed: false },
  {
    kind: "file",
    name: "app.ts",
    path: "src/app.ts",
    depth: 1,
    additions: 0,
    deletions: 0,
    collapsed: false,
  },
  {
    kind: "file",
    name: "README.md",
    path: "README.md",
    depth: 0,
    additions: 0,
    deletions: 0,
    collapsed: false,
  },
];

async function frameOf(props: {
  status?: "loading" | "ready" | "empty" | "error";
  selectedIndex?: number;
  viewing?: ViewingFile | null;
  purpose?: "browse" | "attach-image";
}): Promise<string> {
  const ref = React.createRef<null>();
  const t = await testRender(
    <FilesView
      cwdLabel="/work/project"
      status={props.status ?? "ready"}
      rows={rows}
      selectedIndex={props.selectedIndex ?? 0}
      viewing={props.viewing ?? null}
      width={70}
      height={16}
      syntaxStyle={SyntaxStyle.create()}
      scrollRef={ref as never}
      {...(props.purpose ? { purpose: props.purpose } : {})}
    />,
    { width: 74, height: 18 },
  );
  await t.renderOnce();
  await t.flush();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

describe("FilesView", () => {
  it("Given a file tree, then it lists directories and files with the workspace header", async () => {
    const frame = await frameOf({ selectedIndex: 1 });
    expect(frame).toContain("files ·");
    expect(frame).toContain("src/");
    expect(frame).toContain("app.ts");
    expect(frame).toContain("README.md");
    // The selected file (index 1) carries the ▸ marker.
    const line = frame.split("\n").find((l) => l.includes("app.ts")) ?? "";
    expect(line).toContain("▸");
  });

  it("Given an empty workspace, then it says there are no files", async () => {
    expect(await frameOf({ status: "empty" })).toContain("no files");
  });

  it("Given a failed listing, then it shows an error", async () => {
    expect(await frameOf({ status: "error" })).toContain("failed to list files");
  });

  it("Given image attachment mode, then it explains that Enter attaches the selection", async () => {
    const frame = await frameOf({ purpose: "attach-image" });
    expect(frame).toContain("attach image");
    expect(frame).toContain("Enter attach");
  });

  it("Given a viewed file, then it shows the file header and its contents", async () => {
    const frame = await frameOf({
      viewing: { path: "notes.txt", status: "ready", content: "hello\nworld" },
    });
    expect(frame).toContain("file · notes.txt");
    expect(frame).toContain("hello");
    expect(frame).toContain("world");
  });

  it("Given a file that failed to read, then it shows an error", async () => {
    const frame = await frameOf({
      viewing: { path: "x.ts", status: "error", content: "" },
    });
    expect(frame).toContain("failed to read file");
  });
});
