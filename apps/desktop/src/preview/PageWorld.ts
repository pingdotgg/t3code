import { getElementContext } from "react-grab/primitives";

import { installPasskeyBridge, installPasskeyGate } from "./PasskeyBridge.ts";

export interface PageWorldHost {
  /** Absent when this guest has no passkey bridge. */
  readonly invokePasskey?: Parameters<typeof installPasskeyBridge>[0];
  /** Absent when this guest's native passkey requests need no host check. */
  readonly passkeyAllowed?: Parameters<typeof installPasskeyGate>[0];
}

/**
 * Runs in the page's own JavaScript world: React's fibers and `navigator.credentials` cannot be
 * reached from the isolated preload. The preload serializes this function into the page, so the
 * bundler inlines its imports (see `pageWorldFunction` in vite.config.ts), and everything it
 * returns is page-controlled data.
 */
export function installPageWorld(host: PageWorldHost) {
  if (host.invokePasskey) installPasskeyBridge(host.invokePasskey);
  else if (host.passkeyAllowed) installPasskeyGate(host.passkeyAllowed);
  return {
    elementContext: async (element: Element) => {
      const context = await getElementContext(element);
      return {
        selector: context.selector,
        htmlPreview: context.htmlPreview,
        componentName: context.componentName,
        styles: context.styles,
        // Fibers and elements cannot cross back to the preload, so only plain fields are passed.
        stack: context.stack?.map((frame) => ({
          functionName: frame.functionName,
          fileName: frame.fileName,
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
        })),
      };
    },
  };
}
