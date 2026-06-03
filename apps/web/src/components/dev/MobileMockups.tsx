import { MobileBottomNav } from "../mobile/MobileBottomNav";

/**
 * Dev-only visual mockups for mobile UI primitives. Useful for eyeballing the
 * bottom nav and other mobile chrome without booting a full thread.
 *
 * Wrap any of these in a viewport frame at 375 / 600 / 768 to spot-check spacing.
 */
const VIEWPORT_WIDTHS = [375, 414, 600, 767] as const;

function MockupFrame({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{width}px</span>
      <div
        className="relative h-[640px] overflow-hidden rounded-2xl border border-border bg-background shadow-lg"
        style={{ width: `${width}px` }}
      >
        {children}
      </div>
    </div>
  );
}

export function MobileMockups() {
  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <div className="flex min-h-dvh w-full flex-wrap items-start justify-center gap-6 bg-muted/40 p-6">
      {VIEWPORT_WIDTHS.map((width) => (
        <MockupFrame key={`nav-${width}`} width={width}>
          <div className="flex h-full items-end justify-center bg-card p-4 text-xs text-muted-foreground">
            <span>Bottom nav preview ↓</span>
          </div>
          <MobileBottomNav
            onToggleSidebar={() => undefined}
            onToggleTerminal={() => undefined}
            terminalOpen={false}
          />
        </MockupFrame>
      ))}
      {VIEWPORT_WIDTHS.map((width) => (
        <MockupFrame key={`nav-active-${width}`} width={width}>
          <div className="flex h-full items-end justify-center bg-card p-4 text-xs text-muted-foreground">
            <span>Terminal active state</span>
          </div>
          <MobileBottomNav
            onToggleSidebar={() => undefined}
            onToggleTerminal={() => undefined}
            terminalOpen={true}
          />
        </MockupFrame>
      ))}
    </div>
  );
}
