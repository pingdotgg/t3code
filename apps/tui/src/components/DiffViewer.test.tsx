import { describe, expect, it } from "bun:test";
import { SyntaxStyle } from "@opentui/core";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { DiffViewer, type DiffStatus } from "./DiffViewer.tsx";

async function frameOf(props: {
  status: DiffStatus;
  diff?: string;
  turnCount?: number;
  fileCount?: number;
}): Promise<string> {
  const ref = React.createRef<null>();
  const t = await testRender(
    <DiffViewer
      turnCount={props.turnCount ?? 3}
      fileCount={props.fileCount ?? 1}
      status={props.status}
      diff={props.diff ?? ""}
      height={16}
      syntaxStyle={SyntaxStyle.create()}
      scrollRef={ref as never}
    />,
    { width: 80, height: 18 },
  );
  await t.renderOnce();
  await t.flush();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

const sampleDiff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 111..222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = old();",
  "+const b = next();",
  " const c = 3;",
].join("\n");

describe("DiffViewer", () => {
  it("Given a loaded diff, then it shows the turn header and the changed lines", async () => {
    const frame = await frameOf({ status: "ready", diff: sampleDiff, turnCount: 4, fileCount: 1 });
    expect(frame).toContain("diff · turn 4");
    expect(frame).toContain("next()");
  });

  it("Given a loading state, then it shows a loading hint", async () => {
    expect(await frameOf({ status: "loading" })).toContain("loading");
  });

  it("Given an empty turn, then it says there are no changes", async () => {
    expect(await frameOf({ status: "empty" })).toContain("no changes");
  });

  it("Given a failed fetch, then it shows an error", async () => {
    expect(await frameOf({ status: "error" })).toContain("failed to load");
  });
});
