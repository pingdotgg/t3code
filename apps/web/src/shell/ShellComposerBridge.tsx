import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  ShellAction,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef } from "react";

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

const isShellAction = Schema.is(ShellAction);

export interface ShellComposerBridgeProps {
  readonly target: ScopedThreadRef | DraftId;
  readonly routeKind: "server" | "draft";
  readonly prompt: string;
  readonly promptRef: React.RefObject<string>;
  readonly setPrompt: (prompt: string) => void;
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
  const shell = window.t3Shell;
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

  useEffect(() => {
    if (!shell) return;
    void shell.publish("composer", state);
  }, [shell, state]);

  // One subscription for the component's lifetime; handlers read live props.
  const latest = useRef({ props, optionDescriptors, setProviderModelOptions });
  latest.current = { props, optionDescriptors, setProviderModelOptions };
  useEffect(() => {
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onAction((type, payload) => {
        const candidate = {
          ...(typeof payload === "object" && payload !== null ? payload : {}),
          type,
        };
        if (!isShellAction(candidate)) return;
        const {
          props: current,
          optionDescriptors: descriptors,
          setProviderModelOptions: setOptions,
        } = latest.current;
        switch (candidate.type) {
          case "composer.text.set":
            current.setPrompt(candidate.text);
            current.promptRef.current = candidate.text;
            return;
          case "composer.submit":
            if (candidate.text !== undefined) {
              current.setPrompt(candidate.text);
              current.promptRef.current = candidate.text;
            }
            current.onSend(undefined, candidate.intent ?? "foreground");
            return;
          case "composer.interrupt":
            current.onInterrupt();
            return;
          case "composer.model.select":
            current.onProviderModelSelect(
              candidate.instanceId as ProviderInstanceId,
              candidate.model,
            );
            return;
          case "composer.option.set": {
            if (current.noProviderAvailable) return;
            const nextOptions: ModelSelection["options"] = applyComposerOptionChange(
              descriptors,
              candidate.id,
              candidate.value,
            );
            setOptions(current.target, current.selectedProvider, nextOptions, {
              instanceId: current.selectedInstanceId,
              model: current.selectedModel,
              persistSticky: true,
            });
            return;
          }
          case "composer.runtimeMode.set":
            if (current.runtimeModes.some((mode) => mode.value === candidate.mode)) {
              current.onRuntimeModeChange(candidate.mode as RuntimeMode);
            }
            return;
          case "composer.interactionMode.set":
            current.onInteractionModeChange(candidate.mode);
            return;
          default:
            return;
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [shell]);

  return null;
}
