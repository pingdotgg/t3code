import type { PreviewAction } from "./components/preview/previewActionBus";

type MenuZoomAction = Extract<PreviewAction, "zoom-in" | "zoom-out" | "reset-zoom">;
type WindowZoomDirection = "in" | "out" | "reset";

const windowZoomDirectionByAction: Readonly<Record<MenuZoomAction, WindowZoomDirection>> = {
  "zoom-in": "in",
  "zoom-out": "out",
  "reset-zoom": "reset",
};

const isMenuZoomAction = (action: string): action is MenuZoomAction =>
  action === "zoom-in" || action === "zoom-out" || action === "reset-zoom";

export function handleMenuZoomAction(
  action: string,
  input: {
    readonly dispatchPreviewAction: (action: MenuZoomAction) => void;
    readonly previewFocused: boolean;
    readonly zoomWindow: (direction: WindowZoomDirection) => void;
  },
): boolean {
  if (!isMenuZoomAction(action)) return false;
  if (input.previewFocused) {
    input.dispatchPreviewAction(action);
  } else {
    input.zoomWindow(windowZoomDirectionByAction[action]);
  }
  return true;
}
