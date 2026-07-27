import { useEffect, useState } from "react";

import { useReducedMotion } from "./app/useReducedMotion.ts";
import { useSidecar } from "./app/useSidecar.ts";
import { setBackdrop } from "./platform/ipc.ts";
import { applyTheme } from "./theme/applyTheme.ts";
import { DEFAULT_TRANSLUCENCY, backdropForTranslucency } from "./theme/glass.ts";
import { ConnectionSurface } from "./ui/ConnectionSurface.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { Toolbar } from "./ui/Toolbar.tsx";
import { WindowLayers } from "./ui/WindowLayers.tsx";

/**
 * App shell. Port of `RootView` in `ContentView.swift`: a three-column layout
 * (sidebar / detail / inspector) under one toolbar, over the window's layer
 * stack.
 *
 * SwiftUI's `NavigationSplitView` becomes a CSS grid whose track widths
 * animate, which is what makes the sidebar collapse read as a snap rather than
 * a jump — the same thing `withAnimation(Motion.structure)` does around the
 * macOS visibility binding.
 */
export function App() {
  const reduceMotion = useReducedMotion();
  const [translucency] = useState(DEFAULT_TRANSLUCENCY);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [inspectorVisible, setInspectorVisible] = useState(false);
  const sidecar = useSidecar();

  useEffect(() => {
    applyTheme(document.documentElement, { translucency, reduceMotion });
  }, [translucency, reduceMotion]);

  useEffect(() => {
    // Asking DWM for a material behind a fully opaque window is wasted
    // compositing and bleeds through the Windows 11 rounded corners.
    void setBackdrop(backdropForTranslucency(translucency, "mica-alt")).catch(() => {
      // Cosmetic only: a machine without Mica (Windows 10, or a policy that
      // disables transparency) still renders the whole app correctly.
    });
  }, [translucency]);

  return (
    <>
      <WindowLayers seed="surgecode-shell" />
      <div className="shell">
        <Toolbar
          phase={sidecar.phase}
          sidebarVisible={sidebarVisible}
          inspectorVisible={inspectorVisible}
          canToggleInspector={sidecar.phase.kind === "ready"}
          onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
          onToggleInspector={() => setInspectorVisible((visible) => !visible)}
          onNewSession={() => setSidebarVisible(true)}
        />
        <div
          className="columns"
          data-sidebar={sidebarVisible ? "shown" : "collapsed"}
          data-inspector={inspectorVisible ? "shown" : "collapsed"}
        >
          {sidebarVisible ? <Sidebar phase={sidecar.phase} /> : <div className="column" />}
          <div className="column">
            <ConnectionSurface phase={sidecar.phase} session={sidecar.session} />
          </div>
          <div className="column column--inspector" />
        </div>
      </div>
    </>
  );
}
