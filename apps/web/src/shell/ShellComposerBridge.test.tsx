import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ShellComposerState, type T3Shell } from "@t3tools/contracts/shell";
import * as Schema from "effect/Schema";
import { act, useEffect, useRef, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import { ShellComposerBridge, type ShellComposerBridgeProps } from "./ShellComposerBridge";

const decodeComposer = Schema.decodeUnknownSync(ShellComposerState);

const defaults = {
  routeKind: "draft",
  triggerKind: null,
  suggestions: [],
  suggestionsEmptyText: null,
  onSelectSuggestion: () => {},
  onDismissSuggestions: () => {},
  onAttachFiles: () => {},
  onAddTerminalContext: () => {},
  attachments: [],
  terminalContexts: [],
  onRemoveAttachment: () => {},
  onRemoveTerminalContext: () => {},
  placeholder: "Ask anything",
  editorDisabled: false,
  hasSendableContent: true,
  sendDisabledReason: null,
  phase: "ready",
  isSendBusy: false,
  isConnecting: false,
  environmentUnavailable: false,
  noProviderAvailable: true,
  projectSelectionRequired: false,
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  showPlanFollowUpPrompt: false,
  selectedInstanceId: ProviderInstanceId.make("codex"),
  selectedProvider: ProviderDriverKind.make("codex"),
  selectedModel: "test-model",
  selectedProviderModels: [],
  instanceEntries: [],
  modelOptionsByInstance: new Map(),
  modelOptions: null,
  planModeEnabled: false,
  getModelDisabledReason: () => null,
  onProviderModelSelect: () => {},
  runtimeMode: "approval-required",
  runtimeModes: [],
  interactionMode: "default",
  showInteractionModeToggle: false,
  onRuntimeModeChange: () => {},
  onInteractionModeChange: () => {},
  onInterrupt: () => {},
} satisfies Partial<ShellComposerBridgeProps>;

let renderer: ReactTestRenderer | null = null;
let dispatch: Parameters<T3Shell["onAction"]>[0];
let published: ShellComposerState[];
let replaceFromPage: (text: string) => void;
let submitted: string[];

function ComposerPage({ target = "draft-a" }: { target?: string }) {
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const promptRef = useRef(prompt);
  useEffect(() => {
    replaceFromPage = setPrompt;
  }, []);
  return (
    <ShellComposerBridge
      {...defaults}
      target={DraftId.make(target)}
      prompt={prompt}
      promptRef={promptRef}
      setPrompt={setPrompt}
      composerCursor={cursor}
      onCursorChange={setCursor}
      onSend={() => {
        submitted.push(promptRef.current);
        setPrompt("");
        setCursor(0);
      }}
    />
  );
}

beforeEach(async () => {
  published = [];
  submitted = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    t3Shell: {
      publish: async (key, state) => {
        if (key === "composer" && state !== null) {
          published.push(decodeComposer(state));
        }
      },
      onAction: async (listener) => {
        dispatch = listener;
        return () => {};
      },
    } satisfies Pick<T3Shell, "publish" | "onAction">,
  });
  await act(() => {
    renderer = create(<ComposerPage />);
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

const edit = (revision: number) => ({ clientId: "qml-editor", revision });

describe("ShellComposerBridge edit acknowledgements", () => {
  it("publishes the latest batched edit with its text, then retains it across page changes", async () => {
    expect(published.at(-1)).toMatchObject({ text: "", edit: null });
    await act(() => {
      dispatch("composer.text.set", { target: "draft-a", text: "First", cursor: 5, edit: edit(1) });
      dispatch("composer.text.set", {
        target: "draft-a",
        text: "Second",
        cursor: 3,
        edit: edit(2),
      });
    });
    expect(published).toHaveLength(2);
    expect(published.at(-1)).toMatchObject({ text: "Second", cursor: 3, edit: edit(2) });

    await act(() => replaceFromPage("First"));
    expect(published.at(-1)).toMatchObject({ text: "First", edit: edit(2) });
    await act(() => replaceFromPage(""));
    expect(published.at(-1)).toMatchObject({ text: "", edit: edit(2) });
  });

  it("acknowledges the submitted text even when sending clears it in the same render", async () => {
    await act(() => {
      dispatch("composer.text.set", { target: "draft-a", text: "Older", edit: edit(1) });
    });
    await act(() => {
      dispatch("composer.submit", { text: "Newest", edit: edit(2) });
    });
    expect(submitted).toEqual(["Newest"]);
    expect(published.at(-1)).toMatchObject({ text: "", edit: edit(2) });
  });

  it("does not acknowledge edits for another target or carry acknowledgements into it", async () => {
    await act(() => {
      dispatch("composer.text.set", { target: "draft-a", text: "Draft A", edit: edit(1) });
    });
    await act(() => renderer?.update(<ComposerPage target="draft-b" />));
    expect(published.at(-1)).toMatchObject({ target: "draft-b", edit: null });
    const before = published.length;
    await act(() => {
      dispatch("composer.text.set", { target: "draft-a", text: "Stale", edit: edit(2) });
    });
    expect(published).toHaveLength(before);
    await act(() => {
      dispatch("composer.text.set", { target: "draft-b", text: "Draft B", edit: edit(3) });
    });
    expect(published.at(-1)).toMatchObject({ target: "draft-b", text: "Draft B", edit: edit(3) });
  });

  it("still accepts edits from shells without revision support", async () => {
    await act(() => dispatch("composer.text.set", { target: "draft-a", text: "Legacy" }));
    expect(published.at(-1)).toMatchObject({ text: "Legacy", edit: null });
    await act(() => dispatch("composer.submit", { text: "Legacy send" }));
    expect(submitted).toEqual(["Legacy send"]);
    expect(published.at(-1)).toMatchObject({ text: "", edit: null });
  });
});
