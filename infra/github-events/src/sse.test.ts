import { expect, it } from "vite-plus/test";

import type { StoredGitHubEvent } from "./event-log.ts";
import { formatSseEvent } from "./sse.ts";

it("formats github events as resumable server-sent events", () => {
  const event = {
    version: 1,
    sequence: 18,
    deliveryId: "delivery-18",
    event: "issue_comment",
    action: "created",
    repository: { id: 1, fullName: "pingdotgg/t3code", url: null },
    pullRequestNumbers: [42],
    headSha: null,
    actor: null,
    receivedAt: null,
    occurredAt: "2026-08-18T12:00:00Z",
    details: { comment: { body: "line one\nline two" } },
  } satisfies StoredGitHubEvent;

  expect(formatSseEvent(event)).toBe(`id: 18\nevent: github\ndata: ${JSON.stringify(event)}\n\n`);
});
