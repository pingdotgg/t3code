export const WIDER_SCROLLBARS_ATTRIBUTE = "data-wider-scrollbars";

export function applyAppearanceScrollbarWidth(root: HTMLElement, enabled: boolean): void {
  root.toggleAttribute(WIDER_SCROLLBARS_ATTRIBUTE, enabled);
}
