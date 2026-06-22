import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { ComposerControls } from "../controls.ts";
import type { VcsStatusResult } from "@t3tools/contracts";
import { SettingsView } from "./SettingsView.tsx";

const controls: ComposerControls = {
  interactionMode: "plan",
  runtimeMode: "full-access",
  model: "gpt-5",
  reasoning: "high",
};

const vcsStatus = {
  refName: "feature/x",
  hasWorkingTreeChanges: true,
  pr: { number: 7, state: "open" },
} as unknown as VcsStatusResult;

describe("SettingsView", () => {
  it("renders the provider, source-control, and keybinding sections", async () => {
    const ref = React.createRef<null>();
    const t = await testRender(
      <SettingsView
        controls={controls}
        vcsStatus={vcsStatus}
        width={70}
        height={20}
        scrollRef={ref as never}
      />,
      { width: 74, height: 22 },
    );
    await t.renderOnce();
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("settings");
    // Providers + source control (live state).
    expect(frame).toContain("gpt-5");
    expect(frame).toContain("feature/x");
    expect(frame).toContain("#7 open");
    // Keybindings reference.
    expect(frame).toContain("Command palette");
    expect(frame).toContain("^K");
    t.renderer.destroy();
  });
});
