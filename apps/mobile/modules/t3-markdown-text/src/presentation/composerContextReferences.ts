type ComposerContextKind = string;
type ComposerContextId = string;
const COMPOSER_CONTEXT_LABEL_MAX_CHARS = 512;
const CONTEXT_PROTOCOL = "t3-context:";
const COMPOSER_CONTEXT_HREF_PREFIX = `${CONTEXT_PROTOCOL}//v1/`;
const CONTEXT_KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const CONTEXT_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
const MAX_LINK_LABEL_LENGTH = 512;
const CONTEXT_LINK = new RegExp(
  String.raw`(!?)\[([^\]\n]{0,${MAX_LINK_LABEL_LENGTH}})\]\((${COMPOSER_CONTEXT_HREF_PREFIX}[^\s)]{1,200})\)`,
  "g",
);

export function formatComposerContextHref(kind: ComposerContextKind, contextId: ComposerContextId) {
  return `${COMPOSER_CONTEXT_HREF_PREFIX}${kind}/${contextId}`;
}

export function parseComposerContextHref(
  href: string,
): { kind: ComposerContextKind; contextId: ComposerContextId } | null {
  if (!href.startsWith(COMPOSER_CONTEXT_HREF_PREFIX)) return null;
  const rest = href.slice(COMPOSER_CONTEXT_HREF_PREFIX.length);
  const parts = rest.split("/");
  if (parts.length !== 2) return null;
  const [kind, contextId] = parts as [string, string];
  if (!CONTEXT_KIND_PATTERN.test(kind) || !CONTEXT_ID_PATTERN.test(contextId)) return null;
  return { kind, contextId: contextId as ComposerContextId };
}

/** Labels must survive a Markdown link: no brackets or line breaks, bounded, never empty. */
export function sanitizeComposerContextLabel(label: string, kind: ComposerContextKind): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMPOSER_CONTEXT_LABEL_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : kind;
}

export function formatComposerContextReference(reference: {
  kind: ComposerContextKind;
  contextId: ComposerContextId;
  label: string;
}): string {
  const label = sanitizeComposerContextLabel(reference.label, reference.kind);
  const href = formatComposerContextHref(reference.kind, reference.contextId);
  return `${reference.kind === "image" ? "!" : ""}[${label}](${href})`;
}

