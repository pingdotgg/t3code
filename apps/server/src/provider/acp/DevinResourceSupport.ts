export type DevinResourceContent = {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly text?: string;
};

export type DevinResourceNormalization =
  | { readonly kind: "resource"; readonly resource: DevinResourceContent }
  | { readonly kind: "unsupported"; readonly reason: "invalid" | "oversized" | "binary" };

/** Matches the ACP tool-output retention limit before resource data enters tool event state. */
export const DEVIN_RESOURCE_TEXT_MAX_CHARS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= DEVIN_RESOURCE_TEXT_MAX_CHARS
    ? value
    : undefined;
}

function resourceLink(content: Record<string, unknown>): DevinResourceNormalization {
  const uri = boundedString(content.uri);
  const name = boundedString(content.name);
  const description = content.description === null ? undefined : boundedString(content.description);
  const mimeType = content.mimeType === null ? undefined : boundedString(content.mimeType);
  if (
    !uri ||
    !name ||
    (content.description !== undefined &&
      content.description !== null &&
      description === undefined) ||
    (content.mimeType !== undefined && content.mimeType !== null && mimeType === undefined)
  ) {
    return {
      kind: "unsupported",
      reason: [content.uri, content.name, content.description, content.mimeType].some(
        (value) => typeof value === "string" && value.length > DEVIN_RESOURCE_TEXT_MAX_CHARS,
      )
        ? "oversized"
        : "invalid",
    };
  }
  return {
    kind: "resource",
    resource: {
      uri,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
    },
  };
}

function embeddedResource(content: Record<string, unknown>): DevinResourceNormalization {
  const resource = content.resource;
  if (!isRecord(resource)) {
    return { kind: "unsupported", reason: "invalid" };
  }
  const uri = boundedString(resource.uri);
  const mimeType = resource.mimeType === null ? undefined : boundedString(resource.mimeType);
  if (
    !uri ||
    (resource.mimeType !== undefined && resource.mimeType !== null && mimeType === undefined)
  ) {
    return {
      kind: "unsupported",
      reason: [resource.uri, resource.mimeType].some(
        (value) => typeof value === "string" && value.length > DEVIN_RESOURCE_TEXT_MAX_CHARS,
      )
        ? "oversized"
        : "invalid",
    };
  }
  if ("blob" in resource) {
    return typeof resource.blob === "string"
      ? { kind: "unsupported", reason: "binary" }
      : { kind: "unsupported", reason: "invalid" };
  }
  const text = boundedString(resource.text);
  if (text === undefined) {
    return {
      kind: "unsupported",
      reason:
        typeof resource.text === "string" && resource.text.length > DEVIN_RESOURCE_TEXT_MAX_CHARS
          ? "oversized"
          : "invalid",
    };
  }
  return {
    kind: "resource",
    resource: {
      uri,
      ...(mimeType !== undefined ? { mimeType } : {}),
      text,
    },
  };
}

/**
 * Selects the ACP resource forms that the typed runtime can carry. It intentionally
 * ignores ACP metadata and never reads or decodes binary resource blobs.
 */
export function normalizeDevinResourceContent(content: unknown): DevinResourceNormalization {
  if (!isRecord(content) || content.type !== "content" || !isRecord(content.content)) {
    return { kind: "unsupported", reason: "invalid" };
  }
  switch (content.content.type) {
    case "resource_link":
      return resourceLink(content.content);
    case "resource":
      return embeddedResource(content.content);
    default:
      return { kind: "unsupported", reason: "invalid" };
  }
}
