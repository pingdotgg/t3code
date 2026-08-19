import { ThreadHandoffId, ThreadId, TurnId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadHandoffCard } from "./ThreadHandoffCard";

describe("ThreadHandoffCard", () => {
  it("offers exactly the user-confirmed open and dismiss actions", () => {
    const markup = renderToStaticMarkup(
      <ThreadHandoffCard
        handoff={{
          sourceThreadId: ThreadId.make("source"),
          handoffId: ThreadHandoffId.make("handoff"),
          requestingTurnId: TurnId.make("turn-1"),
          title: "Implement billing",
          prompt: "Implement billing from the approved plan.",
          artifactReferences: ["docs/internals/spec.md", "abc123"],
          state: "available",
          targetThreadId: null,
          requestedAt: "2026-08-18T12:00:00.000Z",
          resolvedAt: "2026-08-18T12:01:00.000Z",
        }}
        onOpen={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("Open Implement billing thread");
    expect(markup).toContain("docs/internals/spec.md · abc123");
    expect(markup).toContain(">Dismiss</button>");
  });
});
