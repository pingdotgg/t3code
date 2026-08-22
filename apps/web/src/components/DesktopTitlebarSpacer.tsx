import { isElectron } from "../env";

interface DesktopTitlebarSpacerProps {
  readonly enabled?: boolean;
}

/** Keeps an otherwise empty Electron workspace draggable when the sidebar is closed. */
export function DesktopTitlebarSpacer({ enabled = isElectron }: DesktopTitlebarSpacerProps) {
  if (!enabled) return null;

  return <div aria-hidden="true" className="workspace-topbar drag-region" />;
}
