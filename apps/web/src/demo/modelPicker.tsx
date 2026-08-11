import {
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";

import "../index.css";
import "./modelPicker.css";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { ComposerFooterModeControls } from "../components/chat/ComposerFooterModeControls";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { demoServerConfig } from "./fixtures";

function ModelPickerDemo() {
  const instanceEntries = useMemo(
    () => deriveProviderInstanceEntries(demoServerConfig.providers),
    [],
  );
  const initialEntry =
    instanceEntries.find((entry) => entry.driverKind === "codex") ?? instanceEntries[0]!;
  const [activeInstanceId, setActiveInstanceId] = useState(initialEntry.instanceId);
  const [model, setModel] = useState(initialEntry.models[0]?.slug ?? "");
  const [modelOptions, setModelOptions] = useState<
    ReadonlyArray<ProviderOptionSelection> | undefined
  >();
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("full-access");
  const [open, setOpen] = useState(true);
  const activeEntry =
    instanceEntries.find((entry) => entry.instanceId === activeInstanceId) ?? initialEntry;
  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        instanceEntries.map((entry) => [
          entry.instanceId,
          entry.models.map((item) => ({ slug: item.slug, name: item.name })),
        ]),
      ),
    [instanceEntries],
  );

  const handleModelChange = (instanceId: ProviderInstanceId, nextModel: string) => {
    setActiveInstanceId(instanceId);
    setModel(nextModel);
    setModelOptions(undefined);
  };

  const handlePickerOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>("[data-chat-provider-model-picker]")?.blur();
        });
      });
    }
  };

  return (
    <main className="flex h-full w-full items-end justify-start overflow-hidden bg-transparent pb-10 pl-5 text-foreground">
      <section className="chat-composer-glass-shell h-40 w-full min-w-0">
        <div className="relative z-10 flex h-full flex-col justify-between p-6">
          <p className="text-muted-foreground/70 text-sm">Pick the model that fits this thread.</p>
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            <ProviderModelPicker
              activeInstanceId={activeInstanceId}
              model={model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="ghost"
              triggerClassName="bg-transparent text-foreground hover:bg-white/[0.05] hover:text-foreground outline-none! ring-0! ring-offset-0! focus-visible:border-transparent! focus-visible:outline-none! focus-visible:ring-0! focus-visible:ring-offset-0!"
              popupSide="top"
              open={open}
              onOpenChange={handlePickerOpenChange}
              onInstanceModelChange={handleModelChange}
            />
            <TraitsPicker
              provider={activeEntry.driverKind}
              instanceId={activeEntry.instanceId}
              models={activeEntry.models}
              model={model}
              prompt=""
              onPromptChange={() => undefined}
              modelOptions={modelOptions}
              onModelOptionsChange={setModelOptions}
              triggerVariant="ghost"
              triggerClassName="text-foreground hover:text-foreground"
            />
            <ComposerFooterModeControls
              showInteractionModeToggle={false}
              interactionMode="default"
              runtimeMode={runtimeMode}
              onToggleInteractionMode={() => undefined}
              onRuntimeModeChange={setRuntimeMode}
            />
          </div>
        </div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ModelPickerDemo />
  </React.StrictMode>,
);
