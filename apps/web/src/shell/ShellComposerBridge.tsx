import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ScopedThreadRef,
  ServerProviderModel,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useShellActions } from "./useShellActions";
import { useShellPublish } from "./useShellPublish";

import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";
import {
  normalizeTerminalContextSelection,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { expandCollapsedComposerCursor } from "../composer-logic";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { AppModelOption } from "../modelSelection";
import type { ProviderInstanceEntry } from "../providerInstances";
import type { ComposerSubmissionIntent } from "../composer-logic";
import type { SessionPhase } from "../types";
import {
  applyComposerOptionChange,
  buildShellComposerState,
  resolveComposerOptionDescriptors,
} from "./shellComposerState";

export interface ShellComposerBridgeProps {
  readonly target: ScopedThreadRef | DraftId;
  readonly routeKind: "server" | "draft";
  readonly prompt: string;
  readonly promptRef: React.RefObject<string>;
  readonly setPrompt: (prompt: string) => void;
  /** Collapsed caret ChatComposer tracks; published expanded for the raw-text editor. */
  readonly composerCursor: number;
  readonly triggerKind: "path" | "slash-command" | "skill" | null;
  readonly suggestions: ReadonlyArray<ComposerCommandItem>;
  readonly suggestionsEmptyText: string | null;
  /** Expanded caret from the shell's editor; re-detects the trigger. */
  readonly onCursorChange: (expandedCursor: number) => void;
  readonly onSelectSuggestion: (item: ComposerCommandItem) => void;
  readonly onDismissSuggestions: () => void;
  /** The drop pipeline (validation, limits, downscaling, uploads). */
  readonly onAttachFiles: (files: File[]) => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
  readonly attachments: ReadonlyArray<{ id: string; name: string }>;
  readonly terminalContexts: ReadonlyArray<{
    id: string;
    terminalLabel: string;
    lineStart: number;
    lineEnd: number;
  }>;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onRemoveTerminalContext: (id: string) => void;
  readonly placeholder: string;
  readonly editorDisabled: boolean;
  readonly hasSendableContent: boolean;
  readonly sendDisabledReason: string | null;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly environmentUnavailable: boolean;
  readonly noProviderAvailable: boolean;
  readonly projectSelectionRequired: boolean;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly showPlanFollowUpPrompt: boolean;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedModel: string;
  readonly selectedProviderModels: ReadonlyArray<ServerProviderModel>;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly planModeEnabled: boolean;
  readonly getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  readonly onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModes: ReadonlyArray<{ value: RuntimeMode; label: string; description: string }>;
  readonly interactionMode: ProviderInteractionMode;
  readonly showInteractionModeToggle: boolean;
  readonly onRuntimeModeChange: (mode: RuntimeMode) => void;
  readonly onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  readonly onSend: (e?: { preventDefault: () => void }, intent?: ComposerSubmissionIntent) => void;
  readonly onInterrupt: () => void;
}

/**
 * Mounted inside ChatComposer when the Qt shell hosts the app. Publishes the
 * composer view model under `composer` and turns `composer.*` actions into the
 * same calls the HTML editor and footer make, so drafts, model selection,
 * sending and interrupting keep one implementation.
 */
export function ShellComposerBridge(props: ShellComposerBridgeProps) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);

  const optionDescriptors = useMemo(
    () =>
      props.noProviderAvailable
        ? []
        : resolveComposerOptionDescriptors({
            provider: props.selectedProvider,
            model: props.selectedModel,
            models: props.selectedProviderModels,
            selections: props.modelOptions,
            planModeEnabled: props.planModeEnabled,
          }),
    [
      props.modelOptions,
      props.noProviderAvailable,
      props.planModeEnabled,
      props.selectedModel,
      props.selectedProvider,
      props.selectedProviderModels,
    ],
  );

  const state = useMemo(
    () =>
      buildShellComposerState({
        target: typeof props.target === "string" ? props.target : scopedThreadKey(props.target),
        routeKind: props.routeKind,
        text: props.prompt,
        cursor: expandCollapsedComposerCursor(props.prompt, props.composerCursor),
        triggerKind: props.triggerKind,
        suggestions: props.suggestions.map((item) => ({
          id: item.id,
          kind: item.type,
          label: item.label,
          description: item.description,
        })),
        suggestionsEmptyText: props.suggestionsEmptyText,
        attachments: props.attachments.map((image) => ({ id: image.id, name: image.name })),
        terminalContexts: props.terminalContexts.map((context) => ({
          id: context.id,
          label: context.terminalLabel,
          lineStart: context.lineStart,
          lineEnd: context.lineEnd,
        })),
        placeholder: props.placeholder,
        editorDisabled: props.editorDisabled,
        hasSendableContent: props.hasSendableContent,
        sendDisabledReason: props.sendDisabledReason,
        isRunning: props.phase === "running",
        isSendBusy: props.isSendBusy,
        isConnecting: props.isConnecting,
        environmentUnavailable: props.environmentUnavailable,
        noProviderAvailable: props.noProviderAvailable,
        projectSelectionRequired: props.projectSelectionRequired,
        pendingApprovalCount: props.pendingApprovalCount,
        pendingUserInputCount: props.pendingUserInputCount,
        showPlanFollowUpPrompt: props.showPlanFollowUpPrompt,
        selectedInstanceId: props.noProviderAvailable ? null : props.selectedInstanceId,
        selectedModel: props.noProviderAvailable ? null : props.selectedModel,
        instanceEntries: props.instanceEntries,
        modelOptionsByInstance: props.modelOptionsByInstance,
        getModelDisabledReason: props.getModelDisabledReason,
        optionDescriptors,
        runtimeMode: props.runtimeMode,
        runtimeModes: props.runtimeModes,
        interactionMode: props.interactionMode,
        showInteractionModeToggle: props.showInteractionModeToggle,
      }),
    [optionDescriptors, props],
  );

  useShellPublish("composer", state);

  useShellActions((action) => {
    switch (action.type) {
      case "composer.text.set":
        props.setPrompt(action.text);
        props.promptRef.current = action.text;
        if (action.cursor !== undefined) {
          props.onCursorChange(action.cursor);
        }
        return;
      case "composer.suggest.select": {
        const item = props.suggestions.find((entry) => entry.id === action.id);
        if (item) props.onSelectSuggestion(item);
        return;
      }
      case "composer.suggest.dismiss":
        props.onDismissSuggestions();
        return;
      case "composer.attach": {
        const files: File[] = [];
        for (const entry of action.files) {
          let bytes: Uint8Array<ArrayBuffer>;
          try {
            bytes = Uint8Array.from(atob(entry.base64), (char) => char.charCodeAt(0));
          } catch {
            console.warn("[shell] dropped attachment with malformed base64:", entry.name);
            continue;
          }
          files.push(new File([bytes], entry.name, { type: entry.mimeType }));
        }
        if (files.length > 0) props.onAttachFiles(files);
        return;
      }
      case "composer.attachment.remove":
        props.onRemoveAttachment(action.id);
        return;
      case "composer.terminalContext.remove":
        props.onRemoveTerminalContext(action.id);
        return;
      case "composer.terminalContext.add": {
        const selection = normalizeTerminalContextSelection({
          terminalId: action.terminalId,
          terminalLabel: action.terminalLabel,
          lineStart: action.lineStart,
          lineEnd: action.lineEnd,
          text: action.text,
        });
        if (selection) props.onAddTerminalContext(selection);
        return;
      }
      case "composer.submit":
        if (action.text !== undefined) {
          props.setPrompt(action.text);
          props.promptRef.current = action.text;
        }
        props.onSend(undefined, action.intent ?? "foreground");
        return;
      case "composer.interrupt":
        props.onInterrupt();
        return;
      case "composer.model.select":
        props.onProviderModelSelect(action.instanceId as ProviderInstanceId, action.model);
        return;
      case "composer.option.set": {
        if (props.noProviderAvailable) return;
        const nextOptions: ModelSelection["options"] = applyComposerOptionChange(
          optionDescriptors,
          action.id,
          action.value,
        );
        setProviderModelOptions(props.target, props.selectedProvider, nextOptions, {
          instanceId: props.selectedInstanceId,
          model: props.selectedModel,
          persistSticky: true,
        });
        return;
      }
      case "composer.runtimeMode.set":
        if (props.runtimeModes.some((mode) => mode.value === action.mode)) {
          props.onRuntimeModeChange(action.mode as RuntimeMode);
        }
        return;
      case "composer.interactionMode.set":
        props.onInteractionModeChange(action.mode);
        return;
      default:
        return;
    }
  });

  return null;
}
