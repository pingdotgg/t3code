import {
  GUEST_COMMAND_OUTPUT_ROUTE,
  GUEST_RENDER_ROUTE,
  GuestShareId,
  GuestStreamEvent,
  MessageId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type GuestTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { GuestPage } from "./GuestPage";

const SHARE_ID = "share-1";
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(GuestStreamEvent));

const base = {
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed",
  title: null,
  startedAt: DateTime.makeUnsafe("2026-10-23T10:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-23T10:00:05.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-23T10:00:05.000Z"),
} as const;

const items: ReadonlyArray<GuestTurnItem> = [
  {
    ...base,
    id: TurnItemId.make("user"),
    ordinal: 0,
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make("user"),
    inputIntent: "turn_start",
    text: "Run the checks",
    attachments: [],
  },
  {
    ...base,
    id: TurnItemId.make("command"),
    ordinal: 1,
    type: "command_execution",
    input: "vp run check:changed",
    outputOmitted: true,
    exitCode: 0,
  },
  {
    ...base,
    id: TurnItemId.make("visual"),
    ordinal: 2,
    type: "dynamic_tool",
    toolName: "mcp__t3-code__html_render",
    input: null,
    output: { htmlRender: { attachmentId: "thread-a-1", title: "Chart", height: 200 } },
  },
  {
    ...base,
    id: TurnItemId.make("reply"),
    ordinal: 3,
    type: "assistant_message",
    messageId: MessageId.make("reply"),
    text: "All checks pass.",
    streaming: false,
  },
];

const snapshot = encodeEvent({
  type: "snapshot",
  view: {
    shareId: GuestShareId.make(SHARE_ID),
    title: "Fix login",
    guestName: "Sam",
    expiresAt: "2026-10-24T10:00:00.000Z",
    messages: [],
    model: { driver: ProviderDriverKind.make("codex"), name: "GPT-5.4", shortName: "5.4" },
  },
  runs: [
    {
      id: RunId.make("run-1"),
      ordinal: 1,
      status: "completed",
      requestedAt: "2026-10-23T10:00:00.000Z",
      startedAt: "2026-10-23T10:00:00.000Z",
      completedAt: "2026-10-23T10:00:05.000Z",
      workStartedAt: "2026-10-23T10:00:00.000Z",
      turnEnded: false,
    },
  ],
  items,
});

const finalOutput = JSON.stringify({
  kind: "replace",
  text: "4 files checked\n",
  truncated: false,
  running: false,
});

/** Delivers the snapshot, or a command's final output, as soon as the page subscribes. */
class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  readyState = 1;
  constructor(readonly url: string) {
    super();
    const data = url.startsWith(GUEST_COMMAND_OUTPUT_ROUTE) ? finalOutput : snapshot;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data })));
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function visit(path: string): Disposable {
  const previous = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", path);
  return {
    [Symbol.dispose]: () => window.history.replaceState(window.history.state, "", previous),
  };
}

describe("GuestPage", () => {
  it("shows the shared thread in the real timeline without opening an environment connection", async () => {
    using _page = visit(`/guest?share=${SHARE_ID}`);
    using _session = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    using _stream = vi.spyOn(window, "EventSource").mockImplementation(FakeEventSource as never);
    using socket = vi.spyOn(window, "WebSocket");
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(<GuestPage />, { container });

    await expect.element(screen.getByText("All checks pass.")).toBeVisible();
    // A finished turn folds its work, as it does for the owner; the command is inside.
    await userEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    await expect.element(screen.getByText("vp run check:changed")).toBeVisible();
    // Expanding the command shows its output, read through the guest route.
    await userEvent.click(screen.getByText("vp run check:changed"));
    await expect.element(screen.getByText("4 files checked")).toBeVisible();
    await expect
      .element(screen.getByTitle("Chart"))
      .toHaveAttribute(
        "src",
        expect.stringContaining(`${GUEST_RENDER_ROUTE}?share=${SHARE_ID}&item=visual`),
      );
    // Guests cannot act on the thread, so no control offers to.
    expect(screen.container.querySelector('[aria-label="Fork from this response"]')).toBeNull();
    expect(socket).not.toHaveBeenCalled();
    // The composer names the thread's model, as the owner's does, with nothing to pick.
    await expect.element(screen.getByLabelText("Model: 5.4")).toBeVisible();
  });
});
