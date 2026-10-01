import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { createNativeSurfaceBridge } from "./nativeBridge";
import { createVersionControlExtension, type VersionControlBindings } from "./version-control";

// Both thread panels and the repository page share one contribution bridge.
export const versionControlBridge = createNativeSurfaceBridge(createVersionControlExtension);

/** The repository page uses the same registered detail contribution without inventing a thread. */
export function NativeVersionControlPanel(props: {
  readonly bindings: VersionControlBindings;
  readonly context: ViewContext;
  readonly visible: boolean;
}) {
  return (
    <versionControlBridge.Surface
      bindings={props.bindings}
      visible={props.visible}
      retainHiddenPresentation
      record={{
        version: 1,
        surfaceId: "t3.version-control/view",
        context: props.context,
        placement: "side-panel",
        stateVersion: 1,
        restoreState: null,
        fallback: "Version Control unavailable",
      }}
    />
  );
}
