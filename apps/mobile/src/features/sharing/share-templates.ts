export interface ShareTemplate {
  readonly id: string;
  readonly prompt: string;
}

export const SHARE_TEMPLATE_PLACEHOLDER = "{{shared}}";

/** Puts the shared text where the template says {{shared}}, or after the template. */
export function applyShareTemplate(prompt: string, sharedText: string): string {
  if (prompt.includes(SHARE_TEMPLATE_PLACEHOLDER)) {
    // split/join, not replaceAll: shared text may contain `$&`-style replacement patterns.
    const result = prompt.trim().split(SHARE_TEMPLATE_PLACEHOLDER).join(sharedText);
    return sharedText ? result : result.trim();
  }
  const template = prompt.trim();
  return sharedText ? `${template}\n\n${sharedText}` : template;
}

export function shareTemplateLabel(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0] ?? "";
  return firstLine.split(SHARE_TEMPLATE_PLACEHOLDER).join("…").trim() || "Template";
}

export function usableShareTemplates(
  templates: ReadonlyArray<ShareTemplate> | undefined,
): ReadonlyArray<ShareTemplate> {
  return (templates ?? []).filter((template) => template.prompt.trim().length > 0);
}

export interface ShareTemplateChoice {
  readonly shareId: string;
  readonly createdAt: string;
  readonly template: string | null;
}

export function selectedShareTemplate(
  share: { readonly id: string; readonly createdAt: string } | null,
  choice: ShareTemplateChoice | null,
): ShareTemplateChoice | null {
  return share && choice?.shareId === share.id && choice.createdAt === share.createdAt
    ? choice
    : null;
}
