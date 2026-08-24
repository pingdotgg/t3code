import { describe, expect, it } from "@effect/vitest";

import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";

import { enqueueDesktopSshPasswordPrompt } from "./sshPasswordPromptQueue";

const request: DesktopSshPasswordPromptRequest = {
  requestId: "desktop-prompt-1",
  destination: "devbox",
  username: "julius",
  prompt: "Enter the SSH password.",
  expiresAt: "2026-08-18T12:03:00.000Z",
  expiresInMs: 3 * 60 * 1_000,
};

describe("desktop SSH password prompt queue", () => {
  it("records when a prompt arrives instead of when it becomes visible", () => {
    const receivedAtMs = Date.parse("2026-08-18T12:05:00.000Z");

    const queued = enqueueDesktopSshPasswordPrompt([], request, receivedAtMs);

    expect(queued[0]).toMatchObject({ receivedAtMs });
  });
});
