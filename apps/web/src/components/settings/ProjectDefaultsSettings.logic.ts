import { DAYBREAK_OPTION_ID, daybreakLabel } from "@t3tools/client-runtime/model-traits";
import type { ModelSelection, ProviderOptionDescriptor } from "@t3tools/contracts";

export function intersectDaybreakDescriptors(
  descriptorSets: ReadonlyArray<ReadonlyArray<ProviderOptionDescriptor>>,
) {
  const representative = descriptorSets[0] ?? [];
  const program = descriptorSets
    .flat()
    .find((descriptor) => descriptor.id === DAYBREAK_OPTION_ID && descriptor.type === "select");
  const descriptors = representative.some((descriptor) => descriptor.id === DAYBREAK_OPTION_ID)
    ? representative
    : [...representative, ...(program ? [program] : [])];
  return descriptors.map((descriptor) =>
    descriptor.id === DAYBREAK_OPTION_ID && descriptor.type === "select"
      ? {
          ...descriptor,
          options: descriptor.options.filter((option) =>
            descriptorSets.every((set) => {
              const matching = set.find(
                (entry) => entry.id === descriptor.id && entry.type === "select",
              );
              // A provider without Daybreak support can still run with it Off.
              return matching?.type === "select"
                ? matching.options.some((choice) => choice.id === option.id)
                : option.id === "standard";
            }),
          ),
        }
      : descriptor,
  );
}

export function blocksBulkDaybreakChange(
  selections: ReadonlyArray<ModelSelection | null | undefined>,
  next: ModelSelection | null,
) {
  const program = next?.options?.find((option) => option.id === DAYBREAK_OPTION_ID)?.value;
  return (
    selections.length !== 1 &&
    selections.some((selection) =>
      selection?.options?.some(
        (option) => option.id === DAYBREAK_OPTION_ID && daybreakLabel(option.value),
      ),
    ) &&
    !selections.every(
      (selection) =>
        next?.options !== undefined &&
        selection?.instanceId === next.instanceId &&
        selection.model === next.model &&
        selection.options?.find((option) => option.id === DAYBREAK_OPTION_ID)?.value === program,
    )
  );
}
