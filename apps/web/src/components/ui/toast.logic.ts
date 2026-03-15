export function shouldHideCollapsedToastContent(
  visibleToastIndex: number,
  visibleToastCount: number,
): boolean {
  // Keep the front-most toast readable even if Base UI marks it as "behind"
  // due to toasts hidden by thread filtering.
  if (visibleToastCount <= 1) return false;
  return visibleToastIndex > 0;
}

type ToastWithHeight = {
  height?: number | null | undefined;
};

type VisibleToastLayoutItem<TToast extends object> = {
  toast: TToast;
  visibleIndex: number;
  offsetY: number;
};

export function buildVisibleToastLayout<TToast extends object>(
  visibleToasts: readonly (TToast & ToastWithHeight)[],
): {
  frontmostHeight: number;
  items: VisibleToastLayoutItem<TToast & ToastWithHeight>[];
} {
  let offsetY = 0;

  return {
    frontmostHeight: normalizeToastHeight(visibleToasts[0]?.height),
    items: visibleToasts.map((toast, visibleIndex) => {
      const item = {
        toast,
        visibleIndex,
        offsetY,
      };

      offsetY += normalizeToastHeight(toast.height);
      return item;
    }),
  };
}

function normalizeToastHeight(height: number | null | undefined): number {
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
}
