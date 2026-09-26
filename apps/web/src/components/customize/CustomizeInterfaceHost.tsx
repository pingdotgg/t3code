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
    <Suspense fallback={null}>
      <CustomizeInterfaceOverlay active={active} onExited={handleExited} />
    </Suspense>
  );
}
