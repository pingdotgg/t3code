export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";

/**
 * Width of the fixed titlebar controls cluster (`[data-workspace-titlebar-controls]`).
 * The cluster grows with what it hosts (maximize, extension menu, dock toggle), so an
 * inline panel tab bar that runs under it reserves this width in CSS instead of a
 * guessed inset.
 */
export const TITLEBAR_CONTROLS_WIDTH_VAR = "--workspace-titlebar-controls-width";

/**
 * Width of the panel layout controls inside the cluster (`[data-panel-layout-controls]`):
 * the Extensions menu, dock toggle, and panel toggles. The chat header reserves this
 * while the right panel is closed; the cluster's maximize slot stays laid out but
 * invisible then, so the header does not reserve it.
 */
export const TITLEBAR_PANEL_CONTROLS_WIDTH_VAR = "--workspace-titlebar-panel-controls-width";

let titlebarControlsPublisher: object | null = null;

/**
 * Publishes the cluster's own width on the document root and keeps it current as the
 * cluster gains or loses controls. Routes remount the cluster as panels open and
 * close, so the latest mounted cluster owns the value and an older one's cleanup
 * leaves it alone. Pass it as the cluster's callback ref: React re-runs it for each
 * element instance, which a ref object read in an effect would miss.
 */
export function publishTitlebarControlsWidth(
  element: HTMLElement | null,
): (() => void) | undefined {
  if (!element) return undefined;
  const style = element.ownerDocument.documentElement.style;
  const publisher = {};
  titlebarControlsPublisher = publisher;
  const publish = (name: string, measured: HTMLElement | null) => {
    if (!measured) {
      style.removeProperty(name);
      return;
    }
    const next = `${Math.ceil(measured.getBoundingClientRect().width)}px`;
    if (style.getPropertyValue(name) !== next) style.setProperty(name, next);
  };
  // The panel controls sit inside the cluster, so any change to them resizes it.
  const measure = () => {
    if (titlebarControlsPublisher !== publisher) return;
    publish(TITLEBAR_CONTROLS_WIDTH_VAR, element);
    publish(
      TITLEBAR_PANEL_CONTROLS_WIDTH_VAR,
      element.querySelector<HTMLElement>("[data-panel-layout-controls]"),
    );
  };
  const resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(element);
  measure();
  return () => {
    resizeObserver.disconnect();
    if (titlebarControlsPublisher !== publisher) return;
    titlebarControlsPublisher = null;
    style.removeProperty(TITLEBAR_CONTROLS_WIDTH_VAR);
    style.removeProperty(TITLEBAR_PANEL_CONTROLS_WIDTH_VAR);
  };
}
