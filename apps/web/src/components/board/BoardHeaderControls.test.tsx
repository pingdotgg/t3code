import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardHeaderControls, getDefaultInitialLane } from "./BoardHeaderControls";

const lanes = [
  { key: "backlog", name: "Backlog", entry: "manual" },
  { key: "implement", name: "Implement", entry: "auto" },
] as const;

describe("BoardHeaderControls", () => {
  it("defaults new tickets to the first board lane", () => {
    expect(getDefaultInitialLane(lanes)).toBe("backlog");
    expect(getDefaultInitialLane([])).toBeNull();
  });

  it("renders only closed board action triggers in the board header", () => {
    const markup = renderToStaticMarkup(
      <BoardHeaderControls boardId="delivery" lanes={lanes} onCreateTicket={() => {}} />,
    );

    expect(markup).not.toContain("Register board");
    expect(markup).toContain("New ticket");
    expect(markup).not.toContain("Edit workflow");
    expect(markup).not.toContain("New ticket title");
    expect(markup).not.toContain("Backlog");
    expect(markup).not.toContain("Implement");
  });

  it("renders the intake trigger only when proposing is wired", () => {
    const without = renderToStaticMarkup(
      <BoardHeaderControls boardId="delivery" lanes={lanes} onCreateTicket={() => {}} />,
    );
    expect(without).not.toContain("Intake");

    const withIntake = renderToStaticMarkup(
      <BoardHeaderControls
        boardId="delivery"
        lanes={lanes}
        onCreateTicket={() => {}}
        onProposeTickets={async () => []}
      />,
    );
    expect(withIntake).toContain("Intake");
  });

  it("renders the workflow editor toggle when provided", () => {
    const markup = renderToStaticMarkup(
      <BoardHeaderControls
        boardId="delivery"
        lanes={lanes}
        workflowEditorOpen={false}
        onCreateTicket={() => {}}
        onToggleWorkflowEditor={() => {}}
      />,
    );

    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>.*Edit workflow<\/button>/s);
    expect(markup).not.toContain("New ticket title");
    expect(markup).not.toContain("Backlog");
  });

  it("renders the New ticket action as a dialog trigger button", () => {
    const markup = renderToStaticMarkup(
      <BoardHeaderControls boardId="delivery" lanes={lanes} onCreateTicket={() => {}} />,
    );

    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>.*New ticket<\/button>/s);
  });
});
