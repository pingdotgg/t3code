import { lazy, Suspense, useCallback, useState } from "react";

import { useCustomizeInterfaceStore } from "./customizeInterfaceStore";

// Mounted above the router on every page, but the palettes only load once the
// mode opens, keeping them out of the startup chunk.
const CustomizeInterfaceOverlay = lazy(() =>
  import("./CustomizeInterfaceOverlay").then((module) => ({
    default: module.CustomizeInterfaceOverlay,
  })),
);

/**
 * Hosts Customize interface mode above the router, so the palettes survive
 * navigation: judging a layout often means opening another thread.
 */
export function CustomizeInterfaceHost() {
  const active = useCustomizeInterfaceStore((store) => store.active);
  // Stays mounted after closing until the exit transition finishes.
  const [mounted, setMounted] = useState(active);
  if (active && !mounted) setMounted(true);
  const handleExited = useCallback(() => setMounted(false), []);
  if (!mounted) return null;
  return (
    // One stacking context keeps even nested handles below app dialogs (z-50)
    // while staying above the composer and other app content (z-40).
    <div className="pointer-events-none fixed inset-0 z-[49] isolate [-webkit-app-region:no-drag]">
      <Suspense fallback={null}>
        <CustomizeInterfaceOverlay active={active} onExited={handleExited} />
      </Suspense>
    </div>
  );
}
