import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { NewThreadHero } from "./NewThreadHero.tsx";

describe("NewThreadHero", () => {
  it("Given a destination project, then it presents the project as a changeable control", async () => {
    const setup = await testRender(
      <NewThreadHero projectTitle="Project one" width={72} height={10} onOpenProject={() => {}} />,
      { width: 72, height: 10 },
    );
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("What should we build in Project one ▾?");
    expect(frame).toContain("click the project or use ^K → Change project");
    setup.renderer.destroy();
  });

  it("Given the project control is clicked, then it opens the project selector", async () => {
    let opens = 0;
    const setup = await testRender(
      <NewThreadHero
        projectTitle="Project one"
        width={72}
        height={10}
        onOpenProject={() => {
          opens += 1;
        }}
      />,
      { width: 72, height: 10 },
    );
    await setup.renderOnce();

    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Project one ▾"));
    const column = lines[row]?.indexOf("Project one") ?? -1;
    expect(row).toBeGreaterThanOrEqual(0);
    expect(column).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(column + 1, row);
    await setup.flush();

    expect(opens).toBe(1);
    setup.renderer.destroy();
  });
});
