import type { EnvironmentId } from "@t3tools/contracts";
import type { FilePreviewItem, FilePreviewSource } from "../components/ui/FilePreviewModal.types";

export function remoteAttachmentImageSource(
  environmentId: EnvironmentId,
  attachmentId: string,
  { name, mimeType }: { readonly name: string; readonly mimeType: string },
) {
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName: name,
    mimeType,
  };
  return {
    kind: "image",
    name,
    environmentId,
    resource,
    actionsSource: { name, mimeType, environmentId, resource },
  } satisfies FilePreviewItem;
}

export function filePreviewKey(source: FilePreviewItem): string {
  if ("resource" in source)
    return JSON.stringify([
      source.environmentId,
      Object.entries(source.resource)
        .filter(([key]) => key !== "mimeType" && key !== "fileName")
        .sort(([a], [b]) => a.localeCompare(b)),
    ]);
  if ("attachment" in source) return `attachment:${source.attachment.id}`;
  return source.uri;
}

/** The thumbnail a gallery page opens from and closes into, including pages that were not tapped. */
export function filePreviewSourceIdentifier(source: FilePreviewItem): string {
  return source.sourceIdentifier ?? `preview:${filePreviewKey(source)}`;
}

export function filePreviewGallery(source: FilePreviewSource, group: readonly FilePreviewItem[]) {
  if (source.kind !== "image") return [source];
  const selectedKey = filePreviewKey(source);
  const seen = new Set<string>();
  const items: FilePreviewItem[] = [];
  for (const item of source.gallery ?? group) {
    if (item.kind !== "image") continue;
    const key = filePreviewKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(key === selectedKey ? source : item);
  }
  if (!seen.has(selectedKey)) items.unshift(source);
  return items;
}

export function filePreviewName(source: FilePreviewItem): string {
  const uriName = "uri" in source ? source.uri.split(/[?#]/)[0]?.split("/").pop() : undefined;
  const name =
    source.name ?? ("attachment" in source ? source.attachment.name : uriName) ?? "Preview";
  const extension = /\.(png|jpe?g|gif|webp|heic|heif|avif|svg|pdf|docx?|xlsx?|pptx?|txt|rtf)$/i;
  const filename =
    source.kind !== "image" || extension.test(name)
      ? name
      : uriName && extension.test(uriName)
        ? uriName
        : name.replace(/\./g, "_");
  return Array.from(filename, (character) =>
    character.charCodeAt(0) < 32 || "/:\\".includes(character) ? "_" : character,
  ).join("");
}
