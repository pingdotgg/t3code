import {
  EventId,
  GUEST_COMMAND_OUTPUT_ROUTE,
  GUEST_RENDER_ROUTE,
  GuestMessageId,
  GuestShareId,
  GuestStreamEvent,
  MessageId,
  ProviderDriverKind,
  RunId,
  TurnItemId,
  type GuestShareView,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { GuestPage } from "./GuestPage";

const SHARE_ID = "share-1";
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(GuestStreamEvent)));

const fixture = makeThreadProjectionFixture();
const threadId = fixture.thread.id;
const started = DateTime.makeUnsafe("2026-10-23T10:00:00.000Z");
const finished = DateTime.makeUnsafe("2026-10-23T10:00:05.000Z");

const run = (id: string, ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(id),
    threadId,
    ordinal,
    providerInstanceId: fixture.thread.providerInstanceId,
    modelSelection: fixture.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`user-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: started,
    startedAt: started,
    completedAt: status === "running" ? null : finished,
    checkpointId: null,
    contextHandoffId: null,
  }) satisfies OrchestrationV2Run;

const itemBase = (id: string, ordinal: number, runId = "run-1") => ({
  id: TurnItemId.make(id),
  threadId,
  runId: RunId.make(runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: started,
  completedAt: finished,
  updatedAt: finished,
});

const reply = (id: string, ordinal: number, text: string, runId?: string) =>
  ({
    ...itemBase(id, ordinal, runId),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming: false,
  }) satisfies OrchestrationV2TurnItem;

const items: ReadonlyArray<OrchestrationV2TurnItem> = [
  {
    ...itemBase("user", 0),
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make("user"),
    inputIntent: "turn_start",
    text: "Run the checks",
    attachments: [],
  },
  // As the owner's stream sends it: the output loads when the row expands.
  {
    ...itemBase("command", 1),
    type: "command_execution",
    input: "vp run check:changed",
    outputOmitted: true,
    exitCode: 0,
  },
  {
    ...itemBase("visual", 2),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__html_render",
    input: null,
    output: { htmlRender: { attachmentId: "thread-a-1", title: "Chart", height: 200 } },
  },
  reply("reply", 3, "All checks pass."),
];

const view: GuestShareView = {
  shareId: GuestShareId.make(SHARE_ID),
  title: "Fix login",
  guestName: "Sam",
  expiresAt: "2026-10-24T10:00:00.000Z",
  messages: [],
  model: { driver: ProviderDriverKind.make("codex"), name: "GPT-5.4", shortName: "5.4" },
};

/** The stream's opening, as the server sends it: the share, then the owner's snapshot. */
const opening = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<GuestStreamEvent> => [
  { type: "view", view },
  {
    type: "thread",
    item: {
      kind: "snapshot",
      snapshotSequence: 1,
      projection: {
        ...fixture,
        runs,
        turnItems,
        visibleTurnItems: turnItems.map((item, position) => ({
          position,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        })),
      },
    },
  },
];

/** One of the owner's thread events, numbered after the snapshot. */
const threadEvent = (
  sequence: number,
  event:
    | { readonly type: "turn-item.updated"; readonly payload: OrchestrationV2TurnItem }
    | { readonly type: "run.updated"; readonly payload: OrchestrationV2Run },
): GuestStreamEvent => {
  const common = {
    id: EventId.make(`event-${sequence}`),
    threadId,
    providerInstanceId: fixture.thread.providerInstanceId,
    occurredAt: finished,
  };
  return {
    type: "thread",
    item: {
      kind: "event",
      sequence,
      event:
        event.type === "run.updated"
          ? { ...common, type: "run.updated", runId: event.payload.id, payload: event.payload }
          : {
              ...common,
              type: "turn-item.updated",
              driver: ProviderDriverKind.make("codex"),
              payload: event.payload,
            },
    },
  };
};

const finalOutput = JSON.stringify({
  kind: "replace",
  text: "4 files checked\n",
  truncated: false,
  running: false,
});

/**
 * Delivers the opening as soon as the page subscribes, or a command's final output. `sources`
 * collects the streams, so a test can send more events.
 */
function fakeEventSource(
  events: ReadonlyArray<GuestStreamEvent>,
  sources: Array<EventTarget> = [],
) {
  return class extends EventTarget {
    static readonly CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) {
      super();
      sources.push(this);
      const frames = url.startsWith(GUEST_COMMAND_OUTPUT_ROUTE)
        ? [finalOutput]
        : events.map((event) => encodeEvent(event));
      queueMicrotask(() => {
        for (const data of frames) this.dispatchEvent(new MessageEvent("message", { data }));
      });
    }
    close() {
      this.readyState = 2;
    }
  };
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
    using _stream = vi
      .spyOn(window, "EventSource")
      .mockImplementation(fakeEventSource(opening([run("run-1", 1, "completed")], items)) as never);
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
    await expect.element(screen.getByLabelText("Model: GPT-5.4")).toBeVisible();
  });

  it("sends attached files with the message, as form data", async () => {
    using _page = visit(`/guest?share=${SHARE_ID}`);
    using fetchSpy = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    using _stream = vi
      .spyOn(window, "EventSource")
      .mockImplementation(fakeEventSource(opening([run("run-1", 1, "completed")], items)) as never);
    await using screen = await render(<GuestPage />);

    await expect.element(screen.getByLabelText("Attach files")).toBeVisible();
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByLabelText("Files to attach"), notes);
    await expect.element(screen.getByText("notes.txt")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/guest/messages?share=${SHARE_ID}`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = fetchSpy.mock.calls.find(
      ([url]) => url === `/api/guest/messages?share=${SHARE_ID}`,
    )?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("shareId")).toBe(SHARE_ID);
    expect(form.get("text")).toBe("");
    expect((form.get("file") as File).name).toBe("notes.txt");
    // Sent files leave the composer.
    await expect.element(screen.getByText("notes.txt")).not.toBeInTheDocument();
  });

  it("follows the end as replies stream, and shows the guest's own message even after they scrolled up", async () => {
    using _page = visit(`/guest?share=${SHARE_ID}`);
    using _session = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const sources: Array<EventTarget> = [];
    // Enough turns that the thread overflows the page.
    const longItems = Array.from({ length: 12 }, (_, index) =>
      reply(
        `reply-${index}`,
        index,
        `Reply ${index}\n\n${"A long paragraph about the change. ".repeat(20)}`,
      ),
    );
    using _stream = vi
      .spyOn(window, "EventSource")
      .mockImplementation(
        fakeEventSource(opening([run("run-1", 1, "running")], longItems), sources) as never,
      );
    const send = (event: GuestStreamEvent) =>
      sources.at(-1)!.dispatchEvent(new MessageEvent("message", { data: encodeEvent(event) }));
    const container = document.createElement("div");
    container.style.cssText = "height: 600px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(<GuestPage />, { container });
    await expect.element(screen.getByText("Reply 11")).toBeInTheDocument();
    const scroller = () =>
      screen.container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
    const expectAtEnd = () =>
      vi.waitFor(() => {
        const node = scroller();
        expect(node.scrollHeight - node.scrollTop - node.clientHeight).toBeLessThan(2);
      });
    await expectAtEnd();

    // A new reply streams in at the end.
    send(
      threadEvent(2, {
        type: "turn-item.updated",
        payload: {
          ...reply(
            "reply-new",
            20,
            `Newest reply\n\n${"More words as the agent writes. ".repeat(30)}`,
          ),
          streaming: true,
        },
      }),
    );
    await expect.element(screen.getByText("Newest reply")).toBeInTheDocument();
    await expectAtEnd();

    // The guest reads back a little, then sends: their message comes into view anyway, as the
    // owner's own send does.
    const node = scroller();
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    node.scrollTop = node.scrollTop - 400;
    node.dispatchEvent(new Event("scroll"));
    await expect.element(screen.getByRole("button", { name: /scroll to/i })).toBeVisible();

    // The guest's own message waits at the end for the owner.
    const waiting = {
      id: GuestMessageId.make("guest-1"),
      text: "Can you also check the logout flow?",
      status: "pending" as const,
      submittedAt: "2026-10-23T10:01:00.000Z",
    };
    send({ type: "view", view: { ...view, messages: [waiting] } });
    await expect.element(screen.getByText(waiting.text)).toBeInTheDocument();
    await expectAtEnd();

    // The owner sends it: the run ends, the message becomes a row, and a new run's reply grows.
    const sent = { ...waiting, status: "sent" as const };
    send(threadEvent(3, { type: "run.updated", payload: run("run-1", 1, "completed") }));
    send({ type: "view", view: { ...view, messages: [sent] } });
    send(threadEvent(4, { type: "run.updated", payload: run("run-2", 2, "running") }));
    send(
      threadEvent(5, {
        type: "turn-item.updated",
        payload: {
          ...itemBase("guest-row", 30, "run-2"),
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("guest-row"),
          inputIntent: "turn_start",
          text: `Message from guest Sam, sent by the owner: ${sent.text}`,
          attachments: [],
          context: {
            version: 1,
            guest: { guestMessageId: sent.id, name: "Sam", text: sent.text },
            records: [],
          },
        },
      }),
    );
    await expectAtEnd();
    for (const [index, words] of [10, 40, 120].entries()) {
      send(
        threadEvent(6 + index, {
          type: "turn-item.updated",
          payload: {
            ...reply(
              "logout-reply",
              31,
              `Logout reply\n\n${"Checking the logout flow now. ".repeat(words)}`,
              "run-2",
            ),
            streaming: true,
          },
        }),
      );
      await expectAtEnd();
      await expect.element(screen.getByText("Logout reply")).toBeInTheDocument();
    }
  });
});
