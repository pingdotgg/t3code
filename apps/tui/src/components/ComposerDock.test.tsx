import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { ComposerDock } from "./ComposerDock.tsx";

describe("ComposerDock", () => {
  it("Given a wide conversation column, then the prompt is centered and bounded like the web composer", async () => {
    const t = await testRender(
      <ComposerDock
        leftWidth={20}
        mainWidth={100}
        rightWidth={0}
        surfaceWidth={80}
        context={{ workspace: "Local checkout", branch: "feature/composer" }}
      >
        <box width={80} border borderStyle="rounded">
          <text>Ask anything</text>
        </box>
      </ComposerDock>,
      { width: 120, height: 4 },
    );
    await t.renderOnce();
    const lines = t.captureCharFrame().split("\n");
    expect((lines[0] ?? "").indexOf("╭")).toBe(30);
    expect(lines.join("\n")).toContain("Local checkout");
    expect(lines.join("\n")).toContain("branch feature/composer");
    t.renderer.destroy();
  });
});
