import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { estimateComposerPayloadWeight } from "./composerPayloadWeight";
import type { ElementContextSelection } from "./elementContext";
import type { TerminalContextDraft } from "./terminalContext";

const terminalContext: TerminalContextDraft = {
  id: "term-1",
  threadId: ThreadId.make("thread-1"),
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1",
  lineStart: 1,
  lineEnd: 2,
  text: "npm test\npassed",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const elementContext: ElementContextSelection = {
  pageUrl: "https://example.com",
  pageTitle: "Example",
  tagName: "button",
  selector: "button.submit",
  htmlPreview: "<button>Save</button>",
  componentName: "SubmitButton",
  source: null,
  styles: ".submit { color: white; }",
};

describe("estimateComposerPayloadWeight", () => {
  it("breaks down prompt, context, review comments, and images", () => {
    const result = estimateComposerPayloadWeight({
      prompt: "Fix this UI",
      terminalContexts: [terminalContext],
      elementContexts: [elementContext],
      reviewComments: [
        {
          id: "review-1",
          sectionId: "file:src/app.ts",
          sectionTitle: "File comment",
          filePath: "src/app.ts",
          startIndex: 0,
          endIndex: 0,
          rangeLabel: "L1",
          text: "Please check this.",
          diff: "const value = 1;",
          fenceLanguage: "ts",
        },
      ],
      attachments: [
        {
          type: "image",
          id: "image_1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 4096,
        },
      ],
    });

    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.sources.map((source) => source.kind)).toEqual([
      "prompt",
      "terminal_context",
      "element_context",
      "review_comment",
      "image",
    ]);
    expect(result.sources.filter((source) => source.trimAvailable)).toHaveLength(4);
  });
});
