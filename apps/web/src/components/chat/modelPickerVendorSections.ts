export interface ModelPickerVendorSection<T> {
  readonly vendor: string;
  readonly models: ReadonlyArray<T>;
}

export function groupModelPickerVendors<T extends { readonly subProvider?: string }>(
  models: ReadonlyArray<T>,
  isPinned: (model: T) => boolean,
): { pinned: ReadonlyArray<T>; sections: ReadonlyArray<ModelPickerVendorSection<T>> } | null {
  const pinned: T[] = [];
  const modelsByVendor = new Map<string, T[]>();
  for (const model of models) {
    if (!model.subProvider || isPinned(model)) {
      pinned.push(model);
      continue;
    }
    const vendorModels = modelsByVendor.get(model.subProvider);
    if (vendorModels) {
      vendorModels.push(model);
    } else {
      modelsByVendor.set(model.subProvider, [model]);
    }
  }
  if (modelsByVendor.size < 2) {
    return null;
  }
  const sections = Array.from(modelsByVendor, ([vendor, vendorModels]) => ({
    vendor,
    models: vendorModels,
  })).toSorted((a, b) => a.vendor.localeCompare(b.vendor, undefined, { sensitivity: "base" }));
  return { pinned, sections };
}
