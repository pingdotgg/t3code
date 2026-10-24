import "~/index.css";

import { RunId } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { TurnDiffFileChange } from "../../types";
import { ChangedFilesCard } from "./ChangedFilesTree";

function file(path: string): TurnDiffFileChange {
  return { path, kind: "modified", additions: 1, deletions: 0 };
}

describe("ChangedFilesCard", () => {
  it("moves the next timeline row up in the same frame a folder collapses", async () => {
    await using screen = await render(
      <LegendList
        data={["files", "after"]}
        keyExtractor={(item) => item}
        estimatedItemSize={100}
        className="h-[600px]"
        renderItem={({ item }) =>
          item === "files" ? (
            <ChangedFilesCard
              runId={RunId.make("run-1")}
              files={[file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]}
              allDirectoriesExpanded
              resolvedTheme="light"
              onToggleAllDirectories={() => {}}
              onOpenTurnDiff={() => {}}
            />
          ) : (
            <div data-testid="after">After</div>
          )
        }
      />,
    );
    const after = () =>
      screen.container.querySelector('[data-testid="after"]')!.getBoundingClientRect().top;
    const cardBottom = () =>
      screen.container.querySelector("[data-changed-files-state]")!.getBoundingClientRect().bottom;
    // The list places rows at the estimated size until it measures the card.
    await vi.waitFor(() => expect(after()).toBe(cardBottom()));
    const topBefore = after();

    const folder = screen.container.querySelector<HTMLButtonElement>(
      '[data-changed-file-row="src"] button',
    )!;
    await act(() => folder.click());

    expect(screen.container.textContent).not.toContain("a.ts");
    expect(after()).toBe(topBefore - 3 * 28);
  });
});
