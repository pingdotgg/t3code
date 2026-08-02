import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChatMessage } from "~/types";
import { MessageSurface } from "./MessageSurface";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div data-chat-markdown>{text}</div>,
}));

describe("MessageSurface", () => {
  it("renders user attachments without exposing injected context", () => {
    const message: ChatMessage = {
      id: MessageId.make("message-1"),
      role: "user",
      text: [
        "Review this screenshot.",
        "",
        "<terminal_context>",
        "- Terminal 1:",
        "  hidden output",
        "</terminal_context>",
      ].join("\n"),
      attachments: [
        {
          type: "image",
          id: "attachment-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1,
          previewUrl: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
      turnId: null,
      streaming: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };

    const markup = renderToStaticMarkup(
      <MessageSurface
        message={message}
        threadRef={scopeThreadRef(
          EnvironmentId.make("environment-local"),
          ThreadId.make("thread-1"),
        )}
        cwd={undefined}
        skills={[]}
        onImageExpand={vi.fn()}
      />,
    );

    expect(markup).toContain('alt="screenshot.png"');
    expect(markup).toContain("Review this screenshot.");
    expect(markup).not.toContain("terminal_context");
    expect(markup).not.toContain("hidden output");
  });
});
