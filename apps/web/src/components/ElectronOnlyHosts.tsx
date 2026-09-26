import { ElectronBrowserHost } from "~/browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./QuitHoldOverlay";
import { PreviewAutomationHosts } from "./preview/PreviewAutomationHosts";

/**
 * Keep desktop-only hosts out of the web startup graph. The module is loaded
 * and awaited by the Electron boot path before the first React commit.
 */
export function ElectronOnlyHosts() {
  return (
    <>
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </>
  );
}
