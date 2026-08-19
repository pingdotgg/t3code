import { ThreadHandoffId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadHandoff } from "./thread-handoff-presentation";

describe("presentThreadHandoff", () => {
  it("keeps the mobile card focused on open or dismiss while retaining artifact context", () => {
    expect(
      presentThreadHandoff({
        sourceThreadId: ThreadId.make("source"),
        handoffId: ThreadHandoffId.make("handoff"),
        requestingTurnId: TurnId.make("turn-1"),
        title: "Implementation",
        prompt: "Implement docs/internals/spec.md",
        artifactReferences: ["docs/internals/spec.md"],
        state: "available",
        targetThreadId: null,
        requestedAt: "2026-08-18T12:00:00.000Z",
        resolvedAt: "2026-08-18T12:01:00.000Z",
      }),
    ).toEqual({
      accessibilityLabel: "Thread handoff: Implementation",
      openLabel: "Open Implementation thread",
      artifactReferences: "docs/internals/spec.md",
    });
  });
});
