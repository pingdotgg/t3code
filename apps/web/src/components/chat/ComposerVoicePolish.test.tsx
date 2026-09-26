import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { ComponentProps } from "react";

const state = vi.hoisted(() => ({
  autoPolish: false,
  connected: true,
  update: vi.fn(),
  polish: vi.fn(),
  run: vi.fn<(input: unknown, options: { signal: AbortSignal }) => Promise<{ text: string }>>(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    autoPolish: state.autoPolish,
    spokenCommands: true,
    removeFillers: true,
    replacements: [],
  }),
  useUpdateEnvironmentSettings: () => state.update,
}));
vi.mock("../../state/session", () => ({
  readPreparedConnection: () => (state.connected ? {} : null),
}));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: state.run } }));
vi.mock("@t3tools/client-runtime/voice-input", () => ({ polishVoice: state.polish }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/menu", () => ({
  Menu: "nav",
  MenuTrigger: "mock-trigger",
  MenuPopup: "mock-popup",
  MenuItem: "li",
  MenuRadioGroup: "select",
  MenuRadioItem: "mock-radio-item",
  MenuRadioItemIndicator: "span",
  MenuSeparator: "hr",
  MenuGroup: "div",
  MenuGroupLabel: "label",
}));
import { ComposerVoicePolish } from "./ComposerVoicePolish";

type Props = ComponentProps<typeof ComposerVoicePolish>;
let renderer: ReactTestRenderer;
let props: Props;
let draft = { ownerKey: "env:thread", text: "hello world", selectionStart: 11, selectionEnd: 11 };
let resolvePolish: (response: { text: string }) => void;
let rejectPolish: (error: Error) => void;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.autoPolish = false;
  state.connected = true;
  const pending = new Promise<{ text: string }>((resolve, reject) => {
    resolvePolish = resolve;
    rejectPolish = reject;
  });
  state.run.mockReturnValue(pending);
  state.update.mockImplementation((patch) => {
    state.autoPolish = patch.dictation.autoPolish;
  });
  draft = { ownerKey: "env:thread", text: "hello world", selectionStart: 11, selectionEnd: 11 };
  props = {
    environmentId: EnvironmentId.make("env"),
    instanceId: ProviderInstanceId.make("codex"),
    busy: false,
    disabled: false,
    completedDraft: null,
    readDraft: () => draft,
    commitDraft: vi.fn((commit) => {
      if (draft.text.slice(commit.rangeStart, commit.rangeEnd) !== commit.expectedText)
        return false;
      draft = {
        ...draft,
        text:
          draft.text.slice(0, commit.rangeStart) +
          commit.insertion +
          draft.text.slice(commit.rangeEnd),
      };
      return true;
    }),
  };
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(() => {
    renderer = create(
      <StrictMode>
        <ComposerVoicePolish {...props} />
      </StrictMode>,
    );
  });
}
async function update(patch: Partial<Props> = {}) {
  props = { ...props, ...patch };
  await act(() =>
    renderer.update(
      <StrictMode>
        <ComposerVoicePolish {...props} />
      </StrictMode>,
    ),
  );
}
async function chooseMode(value: "on" | "off") {
  await act(() => renderer.root.findByType("select").props.onValueChange(value));
  await update();
}
async function complete() {
  await update({
    completedDraft: { ...draft, selectionStart: 0, selectionEnd: draft.text.length },
  });
}
async function clickButton(label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.props.children === label);
  expect(button).toBeDefined();
  await act(() => button?.props.onClick());
}
async function clickMenuItem(label: string) {
  const item = renderer.root.findAllByType("li").find((node) => node.props.children === label);
  expect(item).toBeDefined();
  await act(() => item?.props.onClick());
}

it("defaults to no AI, persists the mode, then polishes the next completed draft with undo", async () => {
  await mount();
  await complete();
  expect(state.run).not.toHaveBeenCalled();
  await chooseMode("on");
  expect(state.update).toHaveBeenCalledWith({
    dictation: { autoPolish: true, spokenCommands: true, removeFillers: true, replacements: [] },
  });
  expect(state.run).not.toHaveBeenCalled();
  await complete();
  expect(state.run).toHaveBeenCalledTimes(1);
  expect(state.polish).toHaveBeenCalledWith({}, props.instanceId, "hello world", "cleanup");
  expect(renderer.root.findByProps({ role: "status" }).props.children).toBe("Polishing…");
  expect(renderer.root.findAllByProps({ role: "region" })).toHaveLength(0);
  await act(() => resolvePolish({ text: "Hello, world!" }));
  expect(draft.text).toBe("Hello, world!");
  expect(renderer.root.findByProps({ role: "status" }).props.children).toBe("Polish");
  expect(renderer.root.findAllByProps({ role: "region" })).toHaveLength(0);
  await clickMenuItem("Undo polish");
  expect(draft.text).toBe("hello world");
});

it.each(["off", "recording", "cancel"] as const)(
  "cancels pending polish on %s and ignores late results",
  async (action) => {
    state.autoPolish = true;
    await mount();
    await complete();
    const signal = state.run.mock.calls[0]?.[1].signal;
    if (action === "off") await chooseMode("off");
    else if (action === "recording") await update({ busy: true, completedDraft: null });
    else await clickMenuItem("Cancel polish");
    expect(signal?.aborted).toBe(true);
    await act(() => resolvePolish({ text: "Late replacement" }));
    expect(props.commitDraft).not.toHaveBeenCalled();
    expect(draft.text).toBe("hello world");
  },
);

it.each(["hello world with my edits", ""])(
  "does not overwrite edited or sent drafts (%s)",
  async (text) => {
    state.autoPolish = true;
    await mount();
    await complete();
    draft = { ...draft, text };
    await act(() => resolvePolish({ text: "Hello, world!" }));
    expect(props.commitDraft).not.toHaveBeenCalled();
    expect(renderer.root.findByType("textarea").props.value).toBe("Hello, world!");
    await clickButton("Apply");
    expect(draft.text).toBe(text);
    expect(props.commitDraft).not.toHaveBeenCalled();
  },
);

it("reports AI failure and leaves the dictation intact", async () => {
  state.autoPolish = true;
  await mount();
  await complete();
  await act(() => rejectPolish(new Error("backend failed")));
  expect(renderer.root.findByProps({ role: "alert" }).props.children).toContain("Could not polish");
  expect(draft.text).toBe("hello world");
  expect(props.commitDraft).not.toHaveBeenCalled();
});

it("reports a missing connection instead of silently doing nothing", async () => {
  state.connected = false;
  state.autoPolish = true;
  await mount();
  await complete();
  expect(renderer.root.findByProps({ role: "alert" }).props.children).toContain("Reconnect");
  expect(state.run).not.toHaveBeenCalled();
});

it("aborts requests when the composer unmounts", async () => {
  state.autoPolish = true;
  await mount();
  await complete();
  const signal = state.run.mock.calls[0]?.[1].signal;
  await act(() => renderer.unmount());
  expect(signal?.aborted).toBe(true);
});
