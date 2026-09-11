import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useState } from "react";
import { ZapIcon } from "lucide-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { getProviderModelCapabilities } from "../../providerModels";
import { useComposerDraftStore, composerTargetKey } from "../../composerDraftStore";
import { Menu, MenuTrigger, MenuPopup, MenuRadioGroup, MenuRadioItem } from "../ui/menu";

export function ThreadSpeedControl({ thread }: { thread: EnvironmentThreadShell }) {
  const environment = useEnvironment(thread.environmentId);
  const provider = environment?.serverConfig?.providers.find(
    (entry) => entry.instanceId === thread.modelSelection.instanceId,
  );
  const [busy, setBusy] = useState(false);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  if (!provider) return null;
  const descriptors = getProviderOptionDescriptors({
    caps: getProviderModelCapabilities(
      provider.models,
      thread.modelSelection.model,
      provider.driver,
    ),
    selections: thread.modelSelection.options,
  });
  const descriptor = descriptors.find(
    (entry) => entry.id === "serviceTier" || entry.id === "fastMode",
  );
  if (!descriptor) return null;
  const choices =
    descriptor.type === "boolean"
      ? [
          { value: false, label: "Normal" },
          { value: true, label: "Fast" },
        ]
      : descriptor.options.map((option) => ({ value: option.id, label: option.label }));
  const selected = choices.findIndex((choice) => choice.value === descriptor.currentValue);
  const label = choices[selected]?.label ?? "Speed";
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  return (
    <div className="agent-thread-speed">
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                aria-label={`Speed for ${thread.title}: ${label}`}
                data-fast={descriptor.currentValue === true || descriptor.currentValue === "fast"}
                disabled={busy || environment?.connection.phase !== "connected"}
              >
                <ZapIcon size={12} />
              </MenuTrigger>
            }
          />
          <TooltipPopup>Speed: {label}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <p className="max-w-60 px-2 py-1.5 text-xs text-muted-foreground">
            Applies to the next provider request. Pricing may vary by speed.
          </p>
          <MenuRadioGroup
            value={String(selected)}
            onValueChange={(value) => {
              const choice = choices[Number(value)];
              if (!choice || busy) return;
              const options = [
                ...(thread.modelSelection.options ?? []).filter(
                  (option) => option.id !== descriptor.id,
                ),
                { id: descriptor.id, value: choice.value },
              ];
              setBusy(true);
              void updateMetadata({
                environmentId: thread.environmentId,
                input: {
                  threadId: thread.id,
                  modelSelection: { ...thread.modelSelection, options },
                },
              })
                .then((result) => {
                  if (result._tag !== "Success") return;
                  // Preserve unsent composer choices while updating this same model's speed.
                  const store = useComposerDraftStore.getState();
                  const draftSelection =
                    store.draftsByThreadKey[composerTargetKey(ref)]?.modelSelectionByProvider[
                      provider.instanceId
                    ];
                  if (draftSelection?.model === thread.modelSelection.model) {
                    store.setProviderModelOptions(
                      ref,
                      provider.driver,
                      [
                        ...(draftSelection.options ?? []).filter(
                          (option) => option.id !== descriptor.id,
                        ),
                        { id: descriptor.id, value: choice.value },
                      ],
                      {
                        instanceId: provider.instanceId,
                        model: thread.modelSelection.model,
                        persistSticky: false,
                      },
                    );
                  }
                })
                .finally(() => setBusy(false));
            }}
          >
            {choices.map((choice, index) => (
              <MenuRadioItem key={String(choice.value)} value={String(index)}>
                {choice.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
