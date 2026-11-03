import { RegistryContext } from "@effect/atom-react";
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

interface NativeEvent {
  readonly value: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly eventCount: number;
  readonly resetGeneration: number;
}

interface NativeProps {
  readonly controlledDocumentJson: string;
  readonly onComposerChange: (event: { readonly nativeEvent: NativeEvent }) => void;
}

// Mirrors the iOS editor's revision and reset bookkeeping (T3ComposerEditorView.setControlledDocumentJson).
const native = vi.hoisted(() => ({
  text: "",
  eventCount: 0,
  resetGeneration: 0,
  props: null as NativeProps | null,
}));

function NativeView(props: NativeProps) {
  useLayoutEffect(() => {
    native.props = props;
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
vi.mock("../state/preferences", async () => {
  const { Atom } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make({ _tag: "Initial" }) };
});
vi.mock("../lib/composerContextClipboard", () => ({ importComposerContextClipboard: vi.fn() }));
vi.mock("../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../lib/nativeComposerTheme", () => ({ createNativeComposerTheme: () => ({}) }));
vi.mock("../lib/contextChipIconSource", () => ({ contextChipIconUri: () => "" }));
vi.mock("../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
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

const DRAFT_KEY = "environment:thread";

function ThreadComposer() {
  const draft = useComposerDraft(DRAFT_KEY);
  return (
    <ComposerEditor
      draftKey={DRAFT_KEY}
      value={draft.text}
      onChangeText={(text) => setComposerDraftText(DRAFT_KEY, text)}
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
