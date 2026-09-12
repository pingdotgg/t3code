import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const DevinModelCatalog = Schema.fromJsonString(
  Schema.Struct({
    families: Schema.Array(
      Schema.Struct({
        slug: Schema.NonEmptyString,
        family_label: Schema.NonEmptyString,
        aliases: Schema.optional(Schema.Array(Schema.String)),
        variants: Schema.Array(
          Schema.Struct({
            model_uid: Schema.NonEmptyString,
            label: Schema.NonEmptyString,
            is_new: Schema.optional(Schema.Boolean),
          }),
        ),
      }),
    ),
  }),
);
type Catalog = typeof DevinModelCatalog.Type;
type Family = Catalog["families"][number];
type Variant = Family["variants"][number];
type SelectableFamily = Family & Pick<ServerProviderModel, "fusion">;

const THINKING_LEVEL_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
];

// The CLI supplies families and exact IDs, but encodes these traits only in labels.
// Keep unfamiliar labels as separate models rather than inventing a mapping.
function variantTraits(family: Family, variant: Variant) {
  if (!variant.label.startsWith(family.family_label)) return undefined;
  const suffix = variant.label.slice(family.family_label.length).trim();
  const match =
    /^(?:(None|No Thinking|Minimal|Low|Medium|High|X-?High|Max|Thinking)(?: Thinking)?)?(?:\s*(Fast))?(?:\s*(1M))?$/i.exec(
      suffix,
    );
  if (!match) return undefined;
  return {
    reasoningEffort: (match[1] ?? "none")
      .toLowerCase()
      .replace("no thinking", "none")
      .replace("-", ""),
    fastMode: match[2] !== undefined,
    contextWindow: match[3] ? "1m" : "standard",
  };
}

function familyVariants(family: Family) {
  const variants = family.variants.flatMap((variant) => {
    const traits = variantTraits(family, variant);
    return traits ? [{ ...variant, ...traits }] : [];
  });
  const combinations = new Set(
    variants.map(
      (variant) => `${variant.reasoningEffort}:${variant.fastMode}:${variant.contextWindow}`,
    ),
  );
  const optionCount = (["reasoningEffort", "fastMode", "contextWindow"] as const).reduce(
    (count, id) => count * new Set(variants.map((variant) => variant[id])).size,
    1,
  );
  // Independent controls must describe a complete, unambiguous product for this account.
  return combinations.size === variants.length && optionCount === variants.length ? variants : [];
}

/** Split Fusion by known lead family and exact sidekick; retain the CLI's native IDs. */
function selectableFamilies(catalog: Catalog): ReadonlyArray<SelectableFamily> {
  const variantsByLabel = new Map(
    catalog.families.flatMap((family) =>
      family.slug === "fusion"
        ? []
        : family.variants.map((variant) => [variant.label, { family, variant }] as const),
    ),
  );
  return catalog.families.flatMap((family) => {
    if (family.slug !== "fusion") return [family];
    const groups = new Map<string, SelectableFamily>();
    const unfamiliar: Variant[] = [];
    for (const variant of family.variants) {
      const pairing = /^Fusion \((.+) \+ (.+)\)$/.exec(variant.label);
      const leadLabel = pairing?.[1];
      const sidekickLabel = pairing?.[2];
      const lead = leadLabel ? variantsByLabel.get(leadLabel)?.family : undefined;
      const sidekick = sidekickLabel ? variantsByLabel.get(sidekickLabel)?.variant : undefined;
      if (!leadLabel || !lead || !sidekick || !leadLabel.startsWith(lead.family_label)) {
        unfamiliar.push(variant);
        continue;
      }
      const slug = `fusion/${lead.slug}/${sidekick.model_uid}`;
      const label = `Fusion (${lead.family_label} + ${sidekick.label})`;
      const group = groups.get(slug);
      const groupedVariant = {
        ...variant,
        label: `${label}${leadLabel.slice(lead.family_label.length)}`,
      };
      groups.set(slug, {
        slug,
        family_label: label,
        fusion: {
          lead: { id: lead.slug, name: lead.family_label },
          sidekick: { id: sidekick.model_uid, name: sidekick.label },
        },
        variants: [...(group?.variants ?? []), groupedVariant],
      });
    }
    return [
      ...groups.values(),
      ...(unfamiliar.length ? [{ ...family, variants: unfamiliar }] : []),
    ];
  });
}

export function devinModels(catalog: Catalog): ServerProviderModel[] {
  return selectableFamilies(catalog).flatMap((family): ServerProviderModel[] => {
    const variants = familyVariants(family);
    if (variants.length !== family.variants.length) {
      return family.variants.map((variant) => ({
        slug: variant.model_uid,
        name: variant.label,
        isCustom: false,
        isDefault: false,
        capabilities: { optionDescriptors: [] },
      }));
    }
    const first = variants[0];
    if (!first) return [];
    const descriptors: ProviderOptionDescriptor[] = [];
    const efforts = THINKING_LEVEL_ORDER.filter((level) =>
      variants.some((variant) => variant.reasoningEffort === level),
    );
    // Keep even a single level so a removed saved choice can be replaced in the picker.
    descriptors.push({
      id: "reasoningEffort",
      label: "Thinking level",
      type: "select",
      currentValue: first.reasoningEffort,
      options: efforts.map((id) => ({
        id,
        label: id === "xhigh" ? "XHigh" : id.charAt(0).toUpperCase() + id.slice(1),
      })),
    });
    if (variants.some((variant) => variant.fastMode !== first.fastMode))
      descriptors.push({
        id: "fastMode",
        label: "Fast mode",
        type: "boolean",
        currentValue: first.fastMode,
      });
    const contexts = ["standard", "1m"].filter((context) =>
      variants.some((variant) => variant.contextWindow === context),
    );
    if (contexts.length > 1)
      descriptors.push({
        id: "contextWindow",
        label: "Context window",
        type: "select",
        currentValue: first.contextWindow,
        options: contexts.map((id) => ({ id, label: id === "1m" ? "1M" : "Standard" })),
      });
    const model: ServerProviderModel = {
      slug: family.slug,
      name: family.family_label,
      isCustom: false,
      isDefault: false,
      capabilities: { optionDescriptors: descriptors },
    };
    const withAliases = family.aliases ? { ...model, aliases: family.aliases } : model;
    const withFusion = family.fusion ? { ...withAliases, fusion: family.fusion } : withAliases;
    return [
      variants.some((variant) => variant.is_new) ? { ...withFusion, badge: "new" } : withFusion,
    ];
  });
}

/** Resolve only combinations present in this account's catalog; never construct native IDs. */
export function resolveDevinModel(
  catalog: Catalog,
  selection: Pick<ModelSelection, "model" | "options">,
) {
  const family = selectableFamilies(catalog).find(
    (family) => family.slug === selection.model || family.aliases?.includes(selection.model),
  );
  // Exact native IDs (including custom models) remain valid for existing sessions.
  if (!family) return selection.model;
  const variants = familyVariants(family);
  const first = variants[0];
  if (!first || variants.length !== family.variants.length)
    return family.variants.find((variant) => variant.model_uid === selection.model)?.model_uid;
  return variants.find((variant) =>
    (["reasoningEffort", "fastMode", "contextWindow"] as const).every(
      (id) =>
        variant[id] === (selection.options?.find((option) => option.id === id)?.value ?? first[id]),
    ),
  )?.model_uid;
}
