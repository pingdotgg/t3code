import { Activity, memo, useState } from "react";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { isProviderInstancePickerReady } from "../../providerInstances";
import { FusionModelPicker } from "./FusionModelPicker";
import { ModelPickerContent, type ModelPickerProps } from "./ModelPickerContent";
import {
  modelPickerInstanceMatchesLock,
  resolveModelPickerSelectedModel,
} from "./modelPickerLogic";

export const ModelPickerViews = memo(function ModelPickerViews(props: ModelPickerProps) {
  const [fusion, setFusion] = useState<{ instanceId: ProviderInstanceId; model: string } | null>(
    () => {
      const entry = props.instanceEntries.find(
        (entry) => entry.instanceId === props.activeInstanceId,
      );
      const model = resolveModelPickerSelectedModel({
        driverKind: entry?.driverKind,
        model: props.model,
        options: props.modelOptionsByInstance.get(props.activeInstanceId) ?? [],
      });
      return model?.fusion && !model.isUnavailable
        ? { instanceId: props.activeInstanceId, model: model.slug }
        : null;
    },
  );
  const entry = props.instanceEntries.find((entry) => entry.instanceId === fusion?.instanceId);
  const models =
    entry &&
    isProviderInstancePickerReady(entry) &&
    modelPickerInstanceMatchesLock(entry, props.lockedProvider, props.lockedContinuationGroupKey)
      ? (props.modelOptionsByInstance.get(entry.instanceId) ?? []).filter(
          (model) =>
            model.fusion &&
            !model.isUnavailable &&
            !props.getModelDisabledReason?.(entry.instanceId, model.slug),
        )
      : [];

  return (
    <>
      {/* Preserve the list's search and scroll state while React cleans up its hidden effects. */}
      <Activity mode={fusion ? "hidden" : "visible"}>
        <ModelPickerContent
          {...props}
          onOpenFusion={(instanceId, model) => setFusion({ instanceId, model })}
        />
      </Activity>
      {fusion && (
        <FusionModelPicker
          models={models}
          model={fusion.model}
          providerName={entry?.displayName ?? "Devin"}
          onBack={() => setFusion(null)}
          onSelect={(model) => props.onInstanceModelChange(fusion.instanceId, model)}
        />
      )}
    </>
  );
});
