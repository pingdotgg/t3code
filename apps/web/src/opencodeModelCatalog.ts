import type {
  ServerProviderModel,
  ServerProviderModelCatalog,
  ServerProviderStatus,
} from "@t3tools/contracts";

function parseModelLabel(model: ServerProviderModel): {
  readonly providerName: string;
  readonly modelName: string;
} {
  const separator = " / ";
  const providerId = model.slug.split("/", 1)[0] ?? "";
  const index = model.name.indexOf(separator);
  if (index < 0) {
    return {
      providerName: providerId || "Provider",
      modelName: model.name,
    };
  }

  return {
    providerName: model.name.slice(0, index),
    modelName: model.name.slice(index + separator.length),
  };
}

function buildFallbackCatalog(
  models: ReadonlyArray<ServerProviderModel>,
): ServerProviderModelCatalog | null {
  if (models.length === 0) {
    return null;
  }

  const groupsById = new Map<
    string,
    {
      id: string;
      name: string;
      models: ServerProviderModel[];
    }
  >();
  for (const model of models) {
    const providerId = model.slug.split("/", 1)[0] ?? "";
    if (!providerId) {
      continue;
    }

    const { modelName, providerName } = parseModelLabel(model);
    const existing = groupsById.get(providerId);
    if (existing) {
      existing.models.push({
        slug: model.slug,
        name: modelName,
      });
      continue;
    }

    groupsById.set(providerId, {
      id: providerId,
      name: providerName,
      models: [
        {
          slug: model.slug,
          name: modelName,
        },
      ],
    });
  }

  const groups = [...groupsById.values()];
  return groups.length > 0 ? { groups } : null;
}

export function getOpencodeModelCatalog(
  status: ServerProviderStatus | undefined,
): ServerProviderModelCatalog | null {
  if (!status || status.provider !== "opencode") {
    return null;
  }

  if (status.modelCatalog) {
    return status.modelCatalog;
  }

  return buildFallbackCatalog(status.models ?? []);
}

export function getOpencodeModelDisplayName(
  catalog: ServerProviderModelCatalog | null,
  slug: string,
): string | null {
  if (!catalog) {
    return null;
  }

  for (const group of catalog.groups) {
    const match = group.models.find((model) => model.slug === slug);
    if (match) {
      return `${group.name} / ${match.name}`;
    }
  }

  const favorite = catalog.favorites?.find((model) => model.slug === slug);
  return favorite?.name ?? null;
}
