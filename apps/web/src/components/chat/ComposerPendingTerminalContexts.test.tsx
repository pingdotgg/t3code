import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPendingTerminalContextChip } from "./ComposerPendingTerminalContexts";

describe("ComposerPendingTerminalContextChip", () => {
  it("renders expired terminal contexts with error styling", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingTerminalContextChip
        context={{
          id: "ctx-expired",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 2,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T18:42:05.449Z",
        }}
      />,
    );

    expect(markup).toContain('data-terminal-context-expired="true"');
    expect(markup).toContain("border-destructive/35");
    expect(markup).toContain("Terminal 1 lines 2-4");
  });
});
