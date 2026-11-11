import * as Arr from "effect/Array";

// Sectioning and the open section come from the pins at open, so starring a model never reflows them.
export function groupModelPickerVendors<
  T extends { readonly subProvider?: string; readonly isLegacy?: boolean },
>(
  models: ReadonlyArray<T>,
  isPinned: (model: T) => boolean,
  isPinnedAtOpen: (model: T) => boolean,
  preferredVendor: string | undefined,
) {
  const currentModels = models.filter((model) => !model.isLegacy || isPinned(model));
  const sortedVendors = (pinned: (model: T) => boolean, candidates = currentModels) =>
    Arr.dedupe(
      candidates.flatMap((model) =>
        model.subProvider !== undefined && !pinned(model) ? [model.subProvider] : [],
      ),
    ).toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const vendorsAtOpen = sortedVendors(
    isPinnedAtOpen,
    models.filter((model) => !model.isLegacy),
  );
  if (vendorsAtOpen.length < 2) {
    return null;
  }
  const inSection = (model: T) => model.subProvider !== undefined && !isPinned(model);
  const modelsByVendor = Arr.groupBy(
    currentModels.filter(inSection),
    (model) => model.subProvider ?? "",
  );
  return {
    pinned: currentModels.filter((model) => !inSection(model)),
    sections: sortedVendors(isPinned).map((vendor) => ({
      vendor,
      models: modelsByVendor[vendor]!,
    })),
    defaultVendor:
      preferredVendor && vendorsAtOpen.includes(preferredVendor)
        ? preferredVendor
        : vendorsAtOpen[0],
  };
}
