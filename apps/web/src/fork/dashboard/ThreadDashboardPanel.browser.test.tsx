import {
  DASHBOARD_SLOT_IDS,
  type DashboardSlotId,
  EnvironmentId,
  ThreadId,
  type ThreadDashboard,
  type ThreadDashboardSlot,
} from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { observeAssistantCitationCommentSource } from "../../components/chat/AssistantCitationSource";
import ChatMarkdown from "../../components/ChatMarkdown";
import { toastManager } from "../../components/ui/toast";
import { render } from "../../../test/render";
import {
  hostRightPanel,
  selectActiveRightPanel,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { DashboardCards } from "./ThreadDashboardPanel";
import { DashboardLinkScope, DashboardMarkdown } from "./dashboardMarkdown";

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const noConfig = Atom.make(null);
  const settings = Atom.make({
    ...DEFAULT_SERVER_SETTINGS,
    threadDashboards: { "dashboard-thread": true, "side-chat": true },
  });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => noConfig) as never,
      settingsValueAtom: (() => settings) as never,
    },
  };
});
vi.mock(import("../../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
// A slot child that renders into a portal, as a chip's image dialog does.
vi.mock(import("./dashboardMarkdown"), async (original) => {
  const { createPortal } = await import("react-dom");
  const actual = await original();
  return {
    ...actual,
    DashboardMarkdown: ((props: { text: string }) => (
      <>
        <actual.DashboardMarkdown {...props} />
        {createPortal(<div data-portaled-child="">Dialog</div>, document.body)}
      </>
    )) as never,
  };
});

type SlotFields = Partial<Omit<ThreadDashboardSlot, "slot">>;

const dashboard = (slots: Partial<Record<DashboardSlotId, SlotFields>> = {}): ThreadDashboard => ({
  threadId: ThreadId.make("dashboard-thread"),
  slots: DASHBOARD_SLOT_IDS.map((slot) => ({
    slot,
    text: "",
    updatedAt: null,
    seenText: null,
    ...slots[slot],
  })),
});

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("dashboard-thread"),
};

function Cards(
  props: Partial<ComponentProps<typeof DashboardCards>> & { readonly dashboard: ThreadDashboard },
) {
  return (
    <DashboardCards threadRef={threadRef} onCite={() => true} onMarkSeen={() => {}} {...props} />
  );
}

function ScopedCards(props: ComponentProps<typeof Cards>) {
  return (
    <DashboardLinkScope value={{ threadRef, cwd: "/home/u/project" }}>
      <Cards {...props} />
    </DashboardLinkScope>
  );
}

const chips = (element: Element) => [
  ...element.querySelectorAll<HTMLAnchorElement>("a.chat-markdown-file-link"),
];

const openedFile = () => {
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  const surface = panel.surfaces.find((entry) => entry.id === panel.activeSurfaceId);
  return surface?.kind === "file" ? surface.relativePath : null;
};

const highlighted = () =>
  [...(CSS.highlights.get("t3-dashboard-change")?.keys() ?? [])].map((range) => range.toString());

const card = (container: HTMLElement, slot: DashboardSlotId) =>
  container.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;

const slotText = (container: HTMLElement, slot: DashboardSlotId) =>
  card(container, slot).querySelector(".chat-markdown p")!.firstChild as Text;

function select(from: Text, start: number, to: Text, end: number) {
  const range = document.createRange();
  range.setStart(from, start);
  range.setEnd(to, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

const citeButton = () => page.getByRole("button", { name: "Cite selection in composer" });

describe("DashboardCards", () => {
  it("shows the six slots in page order and marks empty ones", async () => {
    await using screen = await render(
      <Cards
        dashboard={dashboard({ merged: { text: "PR 12", seenText: "PR 12", updatedAt: null } })}
        onMarkSeen={() => {}}
      />,
    );
    const titles = [...screen.container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(titles).toEqual([
      "Needs your decision",
      "Waiting",
      "Working",
      "Auto review",
      "Human review",
      "Recently merged",
    ]);
    expect(screen.container.querySelectorAll("[data-slot] .chat-markdown")[0]!.textContent).toBe(
      "(empty)",
    );
    expect(screen.container.querySelector("[data-unread]")).toBeNull();
  });

  it("strikes only double-tilde text", async () => {
    await using screen = await render(
      <Cards
        dashboard={dashboard({ working: { text: "1~2 and 3~4, ~~gone~~", updatedAt: null } })}
      />,
    );
    const body = card(screen.container, "working").querySelector(".chat-markdown")!;
    expect(body.textContent).toBe("1~2 and 3~4, gone");
    expect([...body.querySelectorAll("del")].map((node) => node.textContent)).toEqual(["gone"]);
  });

  it("highlights only what the user has not read, and all of a slot they never read", async () => {
    await using screen = await render(
      <Cards
        dashboard={dashboard({
          decide: { text: "Pick A or B", updatedAt: "2026-11-07T00:00:00.000Z" },
          working: {
            text: "- Waiting on the CI run for PR 123\n- Docs",
            seenText: "- Waiting on the CI run for PR 12\n- Docs",
            updatedAt: "2026-11-07T00:00:00.000Z",
          },
        })}
        onMarkSeen={() => {}}
      />,
    );
    await vi.waitFor(() => expect(highlighted().sort()).toEqual(["3", "Pick A or B"]));
    const unread = [...screen.container.querySelectorAll<HTMLElement>("[data-unread]")];
    expect(unread.map((element) => element.dataset.slot)).toEqual(["decide", "working"]);

    await screen.unmount();
    expect(highlighted()).toEqual([]);
  });

  it("marks a changed slot read on a click or Enter, but not on a link", async () => {
    const onMarkSeen = vi.fn();
    const text = "See [the docs](https://example.com/docs) first";
    await using screen = await render(
      <Cards
        dashboard={dashboard({ waiting: { text, updatedAt: "2026-11-07T00:00:00.000Z" } })}
        onMarkSeen={onMarkSeen}
      />,
    );
    screen.container.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
    });

    await userEvent.click(screen.container.querySelector("a")!);
    expect(onMarkSeen).not.toHaveBeenCalled();

    await userEvent.click(card(screen.container, "waiting"), { position: { x: 4, y: 4 } });
    expect(onMarkSeen).toHaveBeenCalledWith("waiting", text);

    card(screen.container, "waiting").focus();
    await userEvent.keyboard("{Enter}");
    expect(onMarkSeen).toHaveBeenCalledTimes(2);
    await userEvent.keyboard(" ");
    expect(onMarkSeen).toHaveBeenCalledTimes(3);

    await userEvent.click(card(screen.container, "decide"), { position: { x: 4, y: 4 } });
    expect(onMarkSeen).toHaveBeenCalledTimes(3);
  });

  it.each([
    { slot: "decide", state: "read" },
    { slot: "waiting", state: "unread" },
  ] as const)("cites selected text of a $state slot without marking it read", async ({ slot }) => {
    const onCite = vi.fn(() => true);
    const onMarkSeen = vi.fn();
    await using screen = await render(
      <Cards
        dashboard={dashboard({
          decide: { text: "Pick A or B", seenText: "Pick A or B" },
          waiting: { text: "CI for PR 12", updatedAt: "2026-11-07T00:00:00.000Z" },
        })}
        onCite={onCite}
        onMarkSeen={onMarkSeen}
      />,
    );
    const text = slotText(screen.container, slot);
    select(text, 0, text, 6);

    await userEvent.click(citeButton());

    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({
        ...threadRef,
        messageId: `dashboard-slot-${slot}`,
        text: text.data.slice(0, 6),
      }),
      expect.anything(),
    );
    expect(onMarkSeen).not.toHaveBeenCalled();
  });

  it("offers no Cite for a selection across two slots", async () => {
    await using screen = await render(
      <Cards dashboard={dashboard({ decide: { text: "Pick A" }, waiting: { text: "CI run" } })} />,
    );
    const decide = slotText(screen.container, "decide");
    select(decide, 0, decide, 4);
    await expect.element(citeButton()).toBeVisible();

    select(decide, 0, slotText(screen.container, "waiting"), 2);
    await expect.element(citeButton()).not.toBeInTheDocument();
  });

  it("tells an open comment on a slot quote that its source is gone when the Dashboard closes", async () => {
    const onCite = vi.fn<ComponentProps<typeof DashboardCards>["onCite"]>(() => true);
    await using screen = await render(
      <Cards dashboard={dashboard({ decide: { text: "Pick A" } })} onCite={onCite} />,
    );
    const text = slotText(screen.container, "decide");
    select(text, 0, text, 4);
    await userEvent.click(citeButton());
    const [citation, anchor] = onCite.mock.calls[0]!;
    const onUnavailable = vi.fn();
    using _observer = {
      [Symbol.dispose]: observeAssistantCitationCommentSource({ anchor, citation, onUnavailable }),
    };

    await screen.unmount();
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce());
  });
});

describe("DashboardCards file references", () => {
  it("opens a backticked path in the file panel without marking the slot read", async () => {
    const onMarkSeen = vi.fn();
    await using screen = await render(
      <ScopedCards
        dashboard={dashboard({
          waiting: { text: "Report at `/home/u/project/report.md`", updatedAt: null },
        })}
        onMarkSeen={onMarkSeen}
      />,
    );
    const [chip] = chips(card(screen.container, "waiting"));
    expect(chip!.textContent).toBe("report.md");

    await userEvent.click(chip!);

    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(panel.isOpen).toBe(true);
    expect(panel.activeSurfaceId).toBe("file:report.md");
    expect(onMarkSeen).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "absolute", text: "[report](/home/u/project/report.md)" },
    { shape: "relative", text: "[r](docs/r.md)" },
    { shape: "file URI", text: "[r](file:///home/u/project/r.md)" },
    { shape: "line anchor", text: "[r](/home/u/project/r.md#L42)" },
    { shape: "reference", text: "[r][ref]\n\n[ref]: /home/u/project/r.md" },
  ])("renders a $shape file link as a chip", async ({ text }) => {
    await using screen = await render(<ScopedCards dashboard={dashboard({ working: { text } })} />);
    const body = card(screen.container, "working");
    expect(chips(body)).toHaveLength(1);
    expect(body.querySelector("a[target=_blank]")).toBeNull();
  });

  it.each([
    {
      shape: "a character reference",
      text: "[report](/home/u/project/a&amp;copy;.md)",
      opens: "a&copy;.md",
    },
    {
      shape: "an angle bracket in a raw HTML link",
      text: '<a href="/home/u/project/a>b.md">report</a>',
      opens: "a>b.md",
    },
  ])("opens the linked file for $shape", async ({ text, opens }) => {
    await using screen = await render(<ScopedCards dashboard={dashboard({ working: { text } })} />);
    const found = chips(card(screen.container, "working"));
    expect(found).toHaveLength(1);

    await userEvent.click(found[0]!);

    expect(openedFile()).toBe(opens);
  });

  it("keeps a descriptive label as the Dashboard renders it, next to the chip", async () => {
    await using screen = await render(
      <ScopedCards
        dashboard={dashboard({
          decide: { text: "[**the** report](/home/u/project/report.md)" },
          waiting: { text: "[$x$](/home/u/project/x.md) and [a\\]b](/home/u/project/b.md)" },
        })}
      />,
    );
    const decide = card(screen.container, "decide");
    expect(decide.querySelector("strong")!.textContent).toBe("the");
    expect(decide.querySelector("p")!.textContent).toBe("the report report.md");

    const waiting = card(screen.container, "waiting");
    expect(waiting.querySelector("p")!.textContent).toBe("$x$ x.md and a]b b.md");
    expect(waiting.querySelector("[data-markdown-math]")).toBeNull();
  });

  it("keeps a path as code without a scope", async () => {
    await using screen = await render(
      <Cards dashboard={dashboard({ working: { text: "See `/home/u/project/report.md`" } })} />,
    );
    const body = card(screen.container, "working");
    expect(chips(body)).toEqual([]);
    expect(body.querySelector("code")!.textContent).toBe("/home/u/project/report.md");
  });

  it("highlights only the added part of a slot with chips, on visible text", async () => {
    const seen =
      "The release notes for this week stay the same in every draft, see `/home/u/project/a.md`.";
    await using screen = await render(
      <ScopedCards
        dashboard={dashboard({
          working: {
            text: `${seen} Then \`/home/u/project/b.md\`.`,
            seenText: seen,
            updatedAt: "2026-11-07T00:00:00.000Z",
          },
        })}
      />,
    );
    const body = card(screen.container, "working").querySelector(".chat-markdown")!;
    await vi.waitFor(() => expect(highlighted().join("")).toBe(" Then b.md."));
    for (const range of CSS.highlights.get("t3-dashboard-change")!.keys()) {
      for (const node of [range.startContainer, range.endContainer]) {
        expect(node.isConnected).toBe(true);
        expect(body.contains(node)).toBe(true);
      }
    }
  });

  it("highlights a path replaced by a same-named file, on visible text", async () => {
    const sentence =
      "The release notes for this week stay the same in every draft and its entry point is";
    await using screen = await render(
      <ScopedCards
        dashboard={dashboard({
          working: {
            text: `${sentence} \`/home/u/project/server/index.ts\`.`,
            seenText: `${sentence} \`/home/u/project/client/index.ts\`.`,
            updatedAt: "2026-11-07T00:00:00.000Z",
          },
        })}
      />,
    );
    const body = card(screen.container, "working").querySelector(".chat-markdown")!;
    await vi.waitFor(() => expect(highlighted().join("")).toBe("server"));
    for (const range of CSS.highlights.get("t3-dashboard-change")!.keys()) {
      for (const node of [range.startContainer, range.endContainer]) {
        expect(node.isConnected).toBe(true);
        expect(body.contains(node)).toBe(true);
      }
    }
  });

  const firstText = (element: Element) =>
    document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode() as Text;

  it.each([
    {
      start: "plain text",
      from: (paragraph: Element) => firstText(paragraph),
      copied: "Read `/home/u/project/a.md` and [notes](/home/u/project/notes.md) now",
    },
    {
      start: "a chip",
      from: (paragraph: Element) => firstText(chips(paragraph)[0]!),
      copied: "`/home/u/project/a.md` and [notes](/home/u/project/notes.md) now",
    },
  ])("copies the slot's markdown for chips when the selection starts in $start", async (row) => {
    const text = "Read `/home/u/project/a.md` and [notes](/home/u/project/notes.md) now";
    await using screen = await render(<ScopedCards dashboard={dashboard({ working: { text } })} />);
    const paragraph = card(screen.container, "working").querySelector("p")!;
    const start = row.from(paragraph);
    const end = paragraph.lastChild as Text;
    select(start, 0, end, end.data.length);
    const clipboardData = new DataTransfer();

    start.parentElement!.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }),
    );

    expect(clipboardData.getData("text/plain")).toBe(row.copied);
  });

  it("does not mark a slot read on a click from a portaled child", async () => {
    const onMarkSeen = vi.fn();
    await using screen = await render(
      <Cards
        dashboard={dashboard({
          waiting: { text: "CI run", updatedAt: "2026-11-07T00:00:00.000Z" },
        })}
        onMarkSeen={onMarkSeen}
      />,
    );
    const portaled = document.querySelector<HTMLElement>("[data-portaled-child]")!;
    expect(card(screen.container, "waiting").contains(portaled)).toBe(false);

    await userEvent.click(portaled);

    expect(onMarkSeen).not.toHaveBeenCalled();
  });

  it("leaves a copy from a portaled child to the child", async () => {
    await using screen = await render(
      <Cards dashboard={dashboard({ waiting: { text: "CI run" } })} />,
    );
    const portaled = document.querySelector<HTMLElement>("[data-portaled-child]")!;
    expect(card(screen.container, "waiting").contains(portaled)).toBe(false);
    const text = portaled.firstChild as Text;
    select(text, 0, text, text.data.length);
    const clipboardData = new DataTransfer();

    portaled.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }),
    );

    expect(clipboardData.getData("text/plain")).toBe("");
  });
});

describe("Dashboard file references match chat", () => {
  const cwd = "/home/u/project";
  // The clipboard serializer copies a chip's wrapper, when it has one, in place of the chip.
  const fileLinks = (root: Element) =>
    [...root.querySelectorAll(".chat-markdown-file-link")].map((chip) => ({
      label: chip.textContent,
      copy: (chip.parentElement?.closest("[data-markdown-copy]") ?? chip).getAttribute(
        "data-markdown-copy",
      ),
    }));

  it.each([
    { shape: "absolute link", text: "See [report](/home/u/project/report.md) now" },
    { shape: "relative link", text: "See [notes](docs/notes.md) now" },
    { shape: "file URI link", text: "See [r](file:///home/u/project/r.md) now" },
    { shape: "line link", text: "See [r](/home/u/project/r.md#L42) now" },
    { shape: "reference link", text: "See [r][ref] now\n\n[ref]: /home/u/project/r.md" },
    { shape: "descriptive label", text: "See [**the** report](/home/u/project/report.md) now" },
    {
      shape: "bare-path label",
      text: "See [/home/u/project/report.md](/home/u/project/report.md) now",
    },
    { shape: "backticked path", text: "See `/home/u/project/report.md` now" },
    {
      shape: "pair of same-named files",
      text: "See `/home/u/project/client/index.ts` and [server](/home/u/project/server/index.ts)",
      chipCount: 2,
    },
  ])("renders a $shape with chat's chip label and copy text", async ({ text, chipCount = 1 }) => {
    await using screen = await render(
      <>
        <div data-renderer="chat">
          <ChatMarkdown text={text} cwd={cwd} threadRef={threadRef} />
        </div>
        <div data-renderer="dashboard">
          <DashboardLinkScope value={{ threadRef, cwd }}>
            <DashboardMarkdown text={text} />
          </DashboardLinkScope>
        </div>
      </>,
    );
    const chat = screen.container.querySelector("[data-renderer=chat]")!;
    const dashboardRoot = screen.container.querySelector("[data-renderer=dashboard]")!;
    await vi.waitFor(() => expect(fileLinks(chat)).toHaveLength(chipCount));

    expect(fileLinks(dashboardRoot)).toEqual(fileLinks(chat));
  });
});

describe("Dashboard links", () => {
  const ref = (threadId: string) => ({ ...threadRef, threadId: ThreadId.make(threadId) });
  const activePanel = (target: typeof threadRef) =>
    selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, target);
  const openButton = () => page.getByRole("button", { name: "Open the Dashboard" });

  it.each([
    { from: "its own thread with the Dashboard on", thread: threadRef, host: null, toast: null },
    {
      from: "a thread with the Dashboard off",
      thread: ref("plain-thread"),
      host: null,
      toast: "This thread's Dashboard is off",
    },
    {
      from: "a side chat with its Dashboard on, hosted in another thread's panel",
      thread: ref("side-chat"),
      host: ref("host-thread"),
      toast: "Open this thread on its own to see its Dashboard",
    },
  ])("a click from $from opens the Dashboard or says why not", async ({ thread, host, toast }) => {
    using _hosted = host ? { [Symbol.dispose]: hostRightPanel(thread, host) } : null;
    await using _screen = await render(
      <ChatMarkdown
        text="See the [Dashboard](t3-dashboard:)."
        cwd={undefined}
        threadRef={thread}
      />,
    );
    await expect.element(openButton()).toHaveTextContent("Dashboard");
    expect(openButton().element().getAttribute("data-markdown-copy")).toBe(
      "[Dashboard](t3-dashboard:)",
    );
    using addToast = vi.spyOn(toastManager, "add");

    await userEvent.click(openButton());

    expect(activePanel(thread)).toBe(toast === null ? "dashboard" : null);
    if (host) expect(activePanel(host)).toBeNull();
    expect(addToast.mock.calls.map(([options]) => options.title)).toEqual(
      toast === null ? [] : [toast],
    );
  });

  it("shows a link to a slot in chat, and any Dashboard link in a slot, as its label", async () => {
    await using screen = await render(
      <>
        <div data-renderer="chat">
          <ChatMarkdown
            text="Pick in [decide](t3-dashboard:decide)."
            cwd={undefined}
            threadRef={threadRef}
          />
        </div>
        <div data-renderer="dashboard">
          <DashboardMarkdown text="See the [Dashboard](t3-dashboard:)." />
        </div>
      </>,
    );
    const chat = screen.container.querySelector("[data-renderer=chat]")!;
    const slot = screen.container.querySelector("[data-renderer=dashboard]")!;
    await vi.waitFor(() => expect(chat.textContent).toBe("Pick in decide."));
    expect(slot.textContent).toBe("See the Dashboard.");
    expect(screen.container.querySelector("a, button")).toBeNull();
  });
});
