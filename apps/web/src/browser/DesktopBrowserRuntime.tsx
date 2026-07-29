import { PreviewAutomationHosts } from "~/components/preview/PreviewAutomationHosts";
import { isElectron } from "~/env";

import { ElectronBrowserHost } from "./ElectronBrowserHost";

export function DesktopBrowserRuntime(props: { readonly authenticated: boolean }) {
  if (!props.authenticated || !isElectron) {
    return null;
  }

  return (
    <>
      <ElectronBrowserHost />
      <PreviewAutomationHosts />
    </>
  );
}
