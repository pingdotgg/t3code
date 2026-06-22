import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { PendingUserInput } from "../userInput.ts";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel.tsx";

const pending: PendingUserInput = {
  requestId: "r1",
  createdAt: "2026-06-19T00:00:00.000Z",
  questions: [
    {
      id: "q1",
      header: "Database",
      question: "Which database driver?",
      options: [
        { label: "Postgres", description: "pg" },
        { label: "SQLite", description: "sqlite" },
        { label: "MySQL", description: "mysql" },
      ],
      multiSelect: false,
    },
  ],
};

async function frameOf(node: React.ReactNode): Promise<string> {
  const t = await testRender(node, { width: 70, height: 12 });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

describe("ComposerPendingUserInputPanel", () => {
  it("Given a question, then it renders the prompt and its options with the cursor", async () => {
    const frame = await frameOf(
      <ComposerPendingUserInputPanel pending={pending} questionIndex={0} optionIndex={0} selectedLabels={[]} width={60} />,
    );
    expect(frame).toContain("Database");
    expect(frame).toContain("Which database driver?");
    expect(frame).toContain("Postgres");
    expect(frame).toContain("SQLite");
    expect(frame).toContain("▸ ( ) Postgres");
    expect(frame).toContain("Enter submit");
  });

  it("Given a selected single-select option, then it shows the filled marker", async () => {
    const frame = await frameOf(
      <ComposerPendingUserInputPanel
        pending={pending}
        questionIndex={0}
        optionIndex={1}
        selectedLabels={["SQLite"]}
        width={60}
      />,
    );
    expect(frame).toContain("(•) SQLite");
    expect(frame).toContain("▸ (•) SQLite");
  });

  it("Given a multi-select question, then it shows checkboxes and the multi hint", async () => {
    const multi: PendingUserInput = {
      ...pending,
      questions: [{ ...pending.questions[0]!, multiSelect: true }],
    };
    const frame = await frameOf(
      <ComposerPendingUserInputPanel pending={multi} questionIndex={0} optionIndex={0} selectedLabels={["Postgres"]} width={60} />,
    );
    expect(frame).toContain("[x] Postgres");
    expect(frame).toContain("[ ] SQLite");
    expect(frame).toContain("Space toggle");
  });
});
