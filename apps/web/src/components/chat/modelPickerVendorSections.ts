import * as Arr from "effect/Array";

export function groupModelPickerVendors<T extends { readonly subProvider?: string }>(
  models: ReadonlyArray<T>,
  isPinned: (model: T) => boolean,
) {
  const inSection = (model: T) => model.subProvider !== undefined && !isPinned(model);
  const modelsByVendor = Arr.groupBy(models.filter(inSection), (model) => model.subProvider ?? "");
  const vendors = Object.keys(modelsByVendor).toSorted((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  if (vendors.length < 2) {
    return null;
  }
  return {
    pinned: models.filter((model) => !inSection(model)),
    sections: vendors.map((vendor) => ({ vendor, models: modelsByVendor[vendor]! })),
  };
}
