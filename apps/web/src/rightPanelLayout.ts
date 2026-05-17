export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

export const PLAN_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_plan_sidebar_width";
export const PLAN_INLINE_DEFAULT_WIDTH = "clamp(20rem,30vw,28rem)";
export const PLAN_INLINE_SIDEBAR_MIN_WIDTH = 20 * 16; // 320px

export const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

/**
 * Returns a width-acceptance validator that checks whether applying `nextWidth`
 * to `cssVarName` on the wrapper element would cause the chat composer to overflow
 * or drop below its minimum usable width.
 *
 * Used by both the diff panel (--sidebar-width) and plan panel (--plan-sidebar-width).
 */
export function createComposerWidthValidator(cssVarName: string) {
  return ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }): boolean => {
    const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
    if (!composerForm) return true;
    const composerViewport = composerForm.parentElement;
    if (!composerViewport) return true;
    const previousWidth = wrapper.style.getPropertyValue(cssVarName);
    wrapper.style.setProperty(cssVarName, `${nextWidth}px`);
    const viewportStyle = window.getComputedStyle(composerViewport);
    const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
    const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
    const viewportContentWidth = Math.max(
      0,
      composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
    );
    const formRect = composerForm.getBoundingClientRect();
    const composerFooter = composerForm.querySelector<HTMLElement>(
      "[data-chat-composer-footer='true']",
    );
    const composerRightActions = composerForm.querySelector<HTMLElement>(
      "[data-chat-composer-actions='right']",
    );
    const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
    const composerFooterGap = composerFooter
      ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
        Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
        0
      : 0;
    const minimumComposerWidth =
      COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
    const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
    const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
    const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;
    if (previousWidth.length > 0) {
      wrapper.style.setProperty(cssVarName, previousWidth);
    } else {
      wrapper.style.removeProperty(cssVarName);
    }
    return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
  };
}
