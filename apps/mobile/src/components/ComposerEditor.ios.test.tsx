import { RegistryContext } from "@effect/atom-react";
import {
  act,
  createRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

interface NativeEvent {
  readonly value: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly eventCount: number;
  readonly resetGeneration: number;
}

interface NativeProps {
  readonly ref?: Ref<unknown>;
  readonly controlledDocumentJson: string;
  readonly onComposerChange: (event: { readonly nativeEvent: NativeEvent }) => void;
}

// Mirrors the iOS editor's revision and reset bookkeeping (T3ComposerEditorView.setControlledDocumentJson).
const native = vi.hoisted(() => ({
  text: "",
  eventCount: 0,
  resetGeneration: 0,
  pasteEventCount: 0,
  mounts: 0,
  props: null as NativeProps | null,
  deliver: null as ((event: NativeEvent) => void) | null,
}));

function NativeView({ ref, ...props }: NativeProps) {
  const propsRef = useRef(props);
  useLayoutEffect(() => {
    Object.assign(native, { text: "", eventCount: 0, resetGeneration: 0, pasteEventCount: 0 });
    native.mounts += 1;
  }, []);
  useImperativeHandle(ref, () => ({
    readState: async () => ({
      value: native.text,
      selection: { start: native.text.length, end: native.text.length },
      eventCount: native.eventCount,
      resetGeneration: native.resetGeneration,
      pasteEventCount: native.pasteEventCount,
    }),
  }));
  useLayoutEffect(() => {
    propsRef.current = props;
    native.props = props;
    native.deliver = (event) => propsRef.current.onComposerChange({ nativeEvent: event });
  });
  const { controlledDocumentJson } = props;
  useLayoutEffect(() => {
    const document = JSON.parse(controlledDocumentJson) as {
      value: string;
      mostRecentEventCount: number;
      resetGeneration?: number;
    };
    const resetGeneration = document.resetGeneration ?? 0;
    const isReset = resetGeneration > native.resetGeneration;
    if (!isReset && document.mostRecentEventCount < native.eventCount) return;
    if (isReset) {
      native.resetGeneration = resetGeneration;
      native.eventCount = document.mostRecentEventCount;
    }
    native.text = document.value;
  }, [controlledDocumentJson]);
  return null;
}

// A native edit whose event has not reached JS yet.
function pend(value: string): NativeEvent {
  native.eventCount += 1;
  native.text = value;
  return {
    value,
    selection: { start: value.length, end: value.length },
    eventCount: native.eventCount,
    resetGeneration: native.resetGeneration,
  };
}

function emit(value: string, resetGeneration = native.resetGeneration) {
  native.eventCount += 1;
  native.text = value;
  native.props!.onComposerChange({
    nativeEvent: {
      value,
      selection: { start: value.length, end: value.length },
      eventCount: native.eventCount,
      resetGeneration,
    },
  });
}

vi.mock("expo", () => ({ requireNativeView: () => NativeView }));
// Vite resolves the platform-neutral module; the race lives in the iOS editor.
vi.mock("../native/T3ComposerEditor", () => import("../native/T3ComposerEditor.ios"));
vi.mock("react-native", () => ({ StyleSheet: { flatten: (style: unknown) => style } }));
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    exists = false;
    write() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("./ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./ui/AppText", () => ({ AppText: ({ children }: { children?: ReactNode }) => children }));
vi.mock("./ComposerContextSheet", () => ({ ComposerContextSheet: () => null }));
vi.mock("../features/threads/useOpenLinkedThread", () => ({ useOpenLinkedThread: () => vi.fn() }));
vi.mock("../state/peerLinks", () => ({ useLinkedEnvironments: () => [] }));
vi.mock("../state/model-mentions", () => ({ useModelMentions: () => [] }));
vi.mock("../state/preferences", async () => {
  const { Atom } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make({ _tag: "Initial" }) };
});
vi.mock("../lib/composerContextClipboard", () => ({ importComposerContextClipboard: vi.fn() }));
vi.mock("../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../lib/nativeComposerTheme", () => ({ createNativeComposerTheme: () => ({}) }));
vi.mock("../lib/contextChipIconSource", () => ({ contextChipIconUri: () => "" }));
vi.mock("../features/settings/appearance/useScaledTextRole", () => ({
  useComposerTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));
vi.mock("../state/assets", () => ({ assetEnvironment: {} }));
vi.mock("../state/attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("../state/session", () => ({ environmentSession: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  settlePromise: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));

import { appAtomRegistry } from "../state/atom-registry";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  setComposerDraftText,
  useComposerDraft,
} from "../state/use-composer-drafts";
import { ComposerEditor } from "./ComposerEditor";
import type { ComposerEditorHandle } from "../native/T3ComposerEditor.types";

const DRAFT_KEY = "environment:thread";

function ThreadComposer({
  draftKey = DRAFT_KEY,
  editorRef,
}: {
  draftKey?: string;
  editorRef?: Ref<ComposerEditorHandle>;
}) {
  const draft = useComposerDraft(draftKey);
  return (
    <ComposerEditor
      ref={editorRef}
      draftKey={draftKey}
      value={draft.text}
      onChangeText={(text) => setComposerDraftText(draftKey, text)}
    />
  );
}

it("keeps a sent draft cleared when an autocorrection lands in the same batch as the send", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(native, { text: "", eventCount: 0, resetGeneration: 0, props: null });
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: async () => act(() => root.unmount()) };
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ThreadComposer />
      </RegistryContext.Provider>,
    ),
  );

  await act(async () => emit("Hello wrold"));
  expect(getComposerDraftSnapshot(DRAFT_KEY).text).toBe("Hello wrold");

  // Send clears the draft; iOS commits the pending autocorrection as the keyboard dismisses.
  await act(async () => {
    clearComposerDraftContent(DRAFT_KEY);
    emit("Hello world");
  });
  expect(getComposerDraftSnapshot(DRAFT_KEY).text).toBe("");
  expect(native.text).toBe("");

  await act(async () => emit("n"));
  expect(getComposerDraftSnapshot(DRAFT_KEY).text).toBe("n");
  expect(native.text).toBe("n");
});

it("keeps a pending event from the previous native editor out of the selected draft", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const first = "switch-draft:first";
  const second = "switch-draft:second";
  setComposerDraftText(first, "Draft A");
  setComposerDraftText(second, "Draft B");
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: async () => act(() => root.unmount()) };
  const renderDraft = (draftKey: string) =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ThreadComposer draftKey={draftKey} />
      </RegistryContext.Provider>,
    );
  await act(async () => renderDraft(first));
  const deliverPendingEvent = native.deliver!;
  const pending = { eventCount: native.eventCount + 1, resetGeneration: native.resetGeneration };
  const mounts = native.mounts;
  await act(async () => renderDraft(second));
  // Remounting the native view would drop the keyboard mid-edit.
  expect(native.mounts).toBe(mounts);
  await act(async () =>
    deliverPendingEvent({
      value: "Draft A corrected",
      selection: { start: 17, end: 17 },
      ...pending,
    }),
  );
  expect(getComposerDraftSnapshot(second).text).toBe("Draft B");
  expect(native.text).toBe("Draft B");
});

async function renderFlushableComposer() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const editor = createRef<ComposerEditorHandle>();
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ThreadComposer editorRef={editor} />
      </RegistryContext.Provider>,
    ),
  );
  return {
    editor,
    [Symbol.asyncDispose]: async () => act(() => root.unmount()),
  };
}

it("sends the autocorrection the Send tap accepted, and its late event cannot refill the draft", async () => {
  await using screen = await renderFlushableComposer();
  await act(async () => emit("Hello wrold"));
  const lateCorrection = pend("Hello world");

  await act(async () => screen.editor.current!.flushPendingInput());
  expect(getComposerDraftSnapshot(DRAFT_KEY).text).toBe("Hello world");

  await act(async () => {
    clearComposerDraftContent(DRAFT_KEY);
    native.deliver!(lateCorrection);
  });
  expect(getComposerDraftSnapshot(DRAFT_KEY).text).toBe("");
});

it("does not flush past a paste whose event has not reached JS", async () => {
  await using screen = await renderFlushableComposer();
  await act(async () => emit("Before"));
  const paste = pend("Before pasted");
  native.pasteEventCount = paste.eventCount;
  const caretMove = pend("Before pasted");

  await act(async () => screen.editor.current!.flushPendingInput());
  expect(getComposerDraftSnapshot(DRAFT_KEY).text).toBe("Before");

  await act(async () => native.deliver!(paste));
  expect(getComposerDraftSnapshot(DRAFT_KEY).text).toBe("Before pasted");
  await act(async () => native.deliver!(caretMove));
  expect(getComposerDraftSnapshot(DRAFT_KEY).text).toBe("Before pasted");
});
