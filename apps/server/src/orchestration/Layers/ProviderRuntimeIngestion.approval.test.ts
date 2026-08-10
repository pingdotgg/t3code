import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

describe("runtimeEventToActivities approval details", () => {
  it("preserves complete multiline command details", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-1"),
      payload: {
        requestType: "command_execution_approval",
        detail,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("approval.requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(detail);
  });

  it("preserves permission approvals for the client", () => {
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-permissions-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-08-10T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("permissions-1"),
      payload: {
        requestType: "permissions_approval",
        detail: "Control the desktop",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.summary).toBe("Permission requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.requestKind).toBe(
      "permissions",
    );
    expect((activity?.payload as Record<string, unknown> | undefined)?.requestType).toBe(
      "permissions_approval",
    );
  });

  it("preserves generic MCP tool approvals for the client", () => {
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-tool-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-08-10T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("tool-1"),
      payload: {
        requestType: "tool_approval",
        detail: "Allow node_repl to run this tool call?",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.summary).toBe("Tool approval requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.requestKind).toBe("tool");
    expect((activity?.payload as Record<string, unknown> | undefined)?.requestType).toBe(
      "tool_approval",
    );
  });
});
