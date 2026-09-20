import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import { SideChat } from "./SideChatPanel";

const state = vi.hoisted(() => ({
  branch: vi.fn(),
  remove: vi.fn(),
  keep: vi.fn(),
  threads: [] as { id: string; latestUserMessageAt?: string | null }[],
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ threads: state.threads }) }));
vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => null }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { createSideChat: "branch", delete: "remove", updateMetadata: "keep" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "branch" | "remove" | "keep") => state[name],
}));
vi.mock("../../hooks/useResizableWidth", () => ({
  useResizableWidth: () => ({ width: 600, handlers: {}, setWidth: vi.fn() }),
}));
vi.mock("./SideChat", () => ({
  SideChatSession: ({ prompt }: { prompt: string }) => {
    const [text, setText] = useState(prompt);
    return <textarea value={text} onChange={(event) => setText(event.target.value)} />;
  },
}));

let renderer: ReactTestRenderer;
const close = vi.fn();
const props = {
  source: { id: "source", environmentId: "env" },
  cwd: undefined,
  request: { serial: 1, prompt: "one" },
  onClose: close,
  settings: {},
  instanceEntries: [],
} as unknown as ComponentProps<typeof SideChat>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.branch.mockReset().mockResolvedValue({ _tag: "Success" });
  state.keep.mockReset().mockResolvedValue({ _tag: "Success" });
  state.remove.mockReset().mockResolvedValue({ _tag: "Success" });
  close.mockReset();
  state.threads = [{ id: "source", latestUserMessageAt: null }];
  await act(async () => {
    renderer = create(<SideChat {...props} />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("opens distinct snapshots and preserves drafts when switching tabs", async () => {
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "unsent one" } }),
  );
  await act(async () =>
    renderer.update(<SideChat {...props} request={{ serial: 2, prompt: "two" }} />),
  );
  expect(state.branch).toHaveBeenCalledTimes(2);
  expect(state.branch.mock.calls[0]![0].input.threadId).not.toBe(
    state.branch.mock.calls[1]![0].input.threadId,
  );
  expect(renderer.root.findAllByType("textarea").map((item) => item.props.value)).toEqual([
    "unsent one",
    "two",
  ]);
  await act(async () => renderer.root.findAllByProps({ role: "tab" })[0]!.props.onClick());
  expect(
    renderer.root.findAllByProps({ role: "tabpanel" }).map((item) => item.props.hidden),
  ).toEqual([false, true]);
});

it("does not lose a newly opened tab when an earlier close finishes", async () => {
  let finish!: (value: { _tag: string }) => void;
  state.remove.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Close side chat 1" }).props.onClick(),
  );
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "New side chat" }).props.onClick(),
  );
  await act(async () => finish({ _tag: "Success" }));
  expect(renderer.root.findAllByProps({ role: "tab" })).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
});

it("hiding and revisiting a side panel preserves its tab and draft without creating a snapshot", async () => {
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "keep my draft" } }),
  );
  await act(async () => renderer.update(<SideChat {...props} visible={false} />));
  await act(async () => renderer.update(<SideChat {...props} visible />));
  expect(state.branch).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByProps({ role: "tab" })).toHaveLength(1);
  expect(renderer.root.findByType("textarea").props.value).toBe("keep my draft");
});

it("a failed close retains both independent drafts and allows a successful retry", async () => {
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "first draft" } }),
  );
  await act(async () =>
    renderer.update(<SideChat {...props} request={{ serial: 2, prompt: "second draft" }} />),
  );
  state.threads.push(
    ...state.branch.mock.calls.map(([request]) => ({ id: request.input.threadId })),
  );
  state.remove.mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Close side chat 1" }).props.onClick(),
  );
  expect(renderer.root.findAllByType("textarea").map((item) => item.props.value)).toEqual([
    "first draft",
    "second draft",
  ]);
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Close side chat 1" }).props.onClick(),
  );
  expect(renderer.root.findByType("textarea").props.value).toBe("second draft");
  expect(state.remove.mock.calls[0]![0]).toEqual(state.remove.mock.calls[1]![0]);
  expect(state.branch).toHaveBeenCalledTimes(2);
});

it("offers to close older snapshots only after a new main user message", async () => {
  const withMessage = (id: string, role: "user" | "assistant", createdAt: string) => {
    if (role === "user") state.threads[0]!.latestUserMessageAt = createdAt;
    return {
      ...props,
      source: { ...props.source, messages: [{ id, role, createdAt }] },
    } as unknown as ComponentProps<typeof SideChat>;
  };
  await act(async () =>
    renderer.update(<SideChat {...withMessage("a", "assistant", "2026-09-11T10:00:00Z")} />),
  );
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  await act(async () =>
    renderer.update(<SideChat {...withMessage("u", "user", "2026-09-11T10:01:00Z")} />),
  );
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  const olderId = state.branch.mock.calls[0]![0].input.threadId;
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "New side chat" }).props.onClick(),
  );
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Close older chats")!
      .props.onClick(),
  );
  expect(state.remove).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { threadId: olderId },
  });
  expect(renderer.root.findAllByProps({ role: "tab" })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});

it("loading old message pages does not prompt to close side chats", async () => {
  await act(async () =>
    renderer.update(
      <SideChat
        {...props}
        source={
          {
            ...props.source,
            messages: [{ role: "user", id: "old", createdAt: "2026-09-10T10:00:00Z" }],
          } as unknown as typeof props.source
        }
      />,
    ),
  );
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  expect(state.remove).not.toHaveBeenCalled();
});

it("keeps the selected tab as a normal thread without deleting other tabs", async () => {
  await act(async () =>
    renderer.update(<SideChat {...props} request={{ serial: 2, prompt: "two" }} />),
  );
  const secondId = state.branch.mock.calls[1]![0].input.threadId;
  const keepButton = renderer.root
    .findAllByType("button")
    .find((button) => button.children.includes("Keep"))!;
  await act(async () => keepButton.props.onClick());
  expect(state.keep).toHaveBeenCalledWith({
    environmentId: "env",
    input: { threadId: secondId, sideChatOf: null },
  });
  expect(state.remove).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType("textarea").map((item) => item.props.value)).toEqual(["one"]);
});
