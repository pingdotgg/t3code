import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { Command } from "../commands.ts";
import { CommandPalette } from "./CommandPalette.tsx";

const cmd = (id: string, title: string, run: () => void, hint?: string): Command =>
  hint ? { id, title, run, hint } : { id, title, run };

describe("CommandPalette", () => {
  it("Given commands, then it lists their titles, hints, and marks the selection", async () => {
    const commands = [
      cmd("new", "New thread", () => {}, "^N"),
      cmd("rename", "Rename thread", () => {}),
    ];
    const t = await testRender(
      <CommandPalette
        commands={commands}
        selectedIndex={1}
        query=""
        width={50}
        maxRows={8}
        onInput={() => {}}
        onRun={() => {}}
      />,
      { width: 54, height: 12 },
    );
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("New thread");
    expect(frame).toContain("^N");
    // The selected (index 1) row carries the ▸ marker.
    const selectedLine = frame.split("\n").find((line) => line.includes("Rename thread")) ?? "";
    expect(selectedLine).toContain("▸");
    t.renderer.destroy();
  });

  it("Given a command row is clicked, then onRun fires with its index", async () => {
    const run: number[] = [];
    const commands = [cmd("a", "Alpha", () => {}), cmd("b", "Bravo", () => {})];
    const t = await testRender(
      <CommandPalette
        commands={commands}
        selectedIndex={0}
        query=""
        width={50}
        maxRows={8}
        onInput={() => {}}
        onRun={(index) => run.push(index)}
      />,
      { width: 54, height: 12 },
    );
    await t.renderOnce();
    await t.flush();
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Bravo"));
    const col = (lines[row] ?? "").indexOf("Bravo");
    await t.mockMouse.click(col, row);
    await t.flush();
    expect(run).toEqual([1]);
    t.renderer.destroy();
  });

  it("Given no matching commands, then it shows an empty hint", async () => {
    const t = await testRender(
      <CommandPalette
        commands={[]}
        selectedIndex={0}
        query="zzz"
        width={50}
        maxRows={8}
        onInput={() => {}}
        onRun={() => {}}
      />,
      { width: 54, height: 12 },
    );
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("no matching command");
    t.renderer.destroy();
  });
});
