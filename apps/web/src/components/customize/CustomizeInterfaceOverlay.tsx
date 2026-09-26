import { useNavigate } from "@tanstack/react-router";
import {
  MessageSquareTextIcon,
  PaletteIcon,
  PanelLeftIcon,
  PanelTopIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  getClientSettings,
  useClientSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  changedCustomizeSettingKeys,
  type CustomizeSurface,
  pickCustomizeSettings,
  readThemeStorageSnapshot,
  THEME_STORAGE_KEYS,
  useCustomizeInterfaceStore,
} from "./customizeInterfaceStore";
import {
  PALETTE_MARGIN,
  type PaletteId,
  type Point,
  type Rect,
  resolvePaletteLayout,
  shouldUseCompactPaletteLayout,
} from "./customizeLayout.logic";
import { CustomizeMark, CustomizePalette, PaletteResetButton } from "./CustomizePalette";
import {
  APPEARANCE_DEFAULTS,
  AppearancePaletteBody,
  ChatHeaderPaletteBody,
  ComposerPaletteBody,
  ThreadListPaletteBody,
} from "./CustomizePalettes";

const ENTER_DURATION_MS = 200;
const DOCK_SIZE = { width: 352, height: 56 };
const DEFAULT_PALETTE_SIZES: Record<PaletteId, { width: number; height: number }> = {
  threadList: { width: 288, height: 420 },
  chatHeader: { width: 288, height: 200 },
  appearance: { width: 288, height: 520 },
  composer: { width: 288, height: 480 },
};
/** Header row of a palette, subtracted when sizing its scrolling body. */
const PALETTE_HEADER_HEIGHT = 44;

const SURFACE_SELECTORS = {
  sidebar: '[data-app-sidebar][data-slot="sidebar-container"]',
  header: "[data-chat-header]",
  composer: '[data-slot="composer-shell"]',
} as const;
type AnchorId = keyof typeof SURFACE_SELECTORS;
type AnchorRects = Record<AnchorId, Rect | null>;

const PALETTE_SURFACE: Record<PaletteId, CustomizeSurface> = {
  threadList: "threadList",
  chatHeader: "chatHeader",
  appearance: "appearance",
  composer: "composer",
};
const ANCHOR_FOR_SURFACE: Partial<Record<CustomizeSurface, AnchorId>> = {
  threadList: "sidebar",
  chatHeader: "header",
  composer: "composer",
};

function readRect(selector: string): Rect | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.right - b.right) < 0.5 &&
    Math.abs(a.bottom - b.bottom) < 0.5);

/**
 * Tracks the surfaces the palettes attach to. Resize observers catch size
 * changes (text size, chat width, a resized sidebar); transitions and a slow
 * safety poll catch moves and surfaces that mount after a navigation. State
 * only changes when a rect actually moved.
 */
function useSurfaceRects(): AnchorRects {
  const [rects, setRects] = useState<AnchorRects>(() => ({
    sidebar: readRect(SURFACE_SELECTORS.sidebar),
    header: readRect(SURFACE_SELECTORS.header),
    composer: readRect(SURFACE_SELECTORS.composer),
  }));
  useEffect(() => {
    let frame = 0;
    const observed = new Map<AnchorId, Element>();
    const measure = () => {
      frame = 0;
      setRects((previous) => {
        const next: AnchorRects = {
          sidebar: readRect(SURFACE_SELECTORS.sidebar),
          header: readRect(SURFACE_SELECTORS.header),
          composer: readRect(SURFACE_SELECTORS.composer),
        };
        return (Object.keys(next) as AnchorId[]).every((id) => sameRect(previous[id], next[id]))
          ? previous
          : next;
      });
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    const observeAnchors = () => {
      for (const id of Object.keys(SURFACE_SELECTORS) as AnchorId[]) {
        const element = document.querySelector(SURFACE_SELECTORS[id]);
        if (observed.get(id) === element) continue;
        const previous = observed.get(id);
        if (previous) observer.unobserve(previous);
        if (element) {
          observer.observe(element);
          observed.set(id, element);
        } else {
          observed.delete(id);
        }
      }
      schedule();
    };
    observeAnchors();
    const poll = window.setInterval(observeAnchors, 500);
    window.addEventListener("resize", schedule);
    document.addEventListener("transitionend", schedule, true);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("transitionend", schedule, true);
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  return rects;
}

function useViewport() {
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return viewport;
}

/**
 * The height a palette would take if nothing capped it: its header plus its
 * full content. Measuring the capped height instead would feed back into
 * placement and shrink the palette a little more on every pass.
 */
function measureNaturalHeight(palette: HTMLElement): number {
  const body = palette.querySelector<HTMLElement>("[data-palette-body]");
  const content = palette.querySelector<HTMLElement>("[data-palette-content]");
  if (!body || !content) return palette.offsetHeight;
  const bodyStyle = getComputedStyle(body);
  const bodyPadding =
    (Number.parseFloat(bodyStyle.paddingTop) || 0) +
    (Number.parseFloat(bodyStyle.paddingBottom) || 0);
  return palette.offsetHeight - body.offsetHeight + content.offsetHeight + bodyPadding;
}

/** Measured palette sizes, so placement accounts for folded or grown palettes. */
function usePaletteSizes() {
  const [sizes, setSizes] = useState(DEFAULT_PALETTE_SIZES);
  const observersRef = useRef(new Map<PaletteId, ResizeObserver>());
  useEffect(
    () => () => {
      for (const observer of observersRef.current.values()) observer.disconnect();
    },
    [],
  );
  // One stable callback per palette, so re-renders don't recreate observers.
  const callbacksRef = useRef(new Map<PaletteId, (element: HTMLElement | null) => void>());
  const refFor = (id: PaletteId) => {
    const existing = callbacksRef.current.get(id);
    if (existing) return existing;
    const callback = (element: HTMLElement | null) => {
      observersRef.current.get(id)?.disconnect();
      observersRef.current.delete(id);
      if (!element) return;
      const observer = new ResizeObserver(() => {
        // Folding swaps the body out, so the content node is re-observed.
        const content = element.querySelector("[data-palette-content]");
        if (content) observer.observe(content);
        const width = element.offsetWidth;
        const height = measureNaturalHeight(element);
        setSizes((previous) =>
          previous[id].width === width && previous[id].height === height
            ? previous
            : { ...previous, [id]: { width, height } },
        );
      });
      observer.observe(element);
      const content = element.querySelector("[data-palette-content]");
      if (content) observer.observe(content);
      observersRef.current.set(id, observer);
    };
    callbacksRef.current.set(id, callback);
    return callback;
  };
  return { sizes, refFor };
}

/** Whether anything changed since the mode opened, for the dock's Revert. */
function useHasChanges(): boolean {
  const snapshot = useCustomizeInterfaceStore((store) => store.snapshot);
  const settings = useClientSettings();
  // Subscribing re-renders on every theme change, so the storage read below
  // is always current.
  useTheme();
  if (!snapshot) return false;
  if (changedCustomizeSettingKeys(snapshot.settings, pickCustomizeSettings(settings)).length > 0) {
    return true;
  }
  const currentTheme = readThemeStorageSnapshot();
  return THEME_STORAGE_KEYS.some((key) => currentTheme[key] !== snapshot.theme[key]);
}

function useRevertChanges() {
  const updateSettings = useUpdateClientSettings();
  const { refreshTheme } = useTheme();
  return useCallback(() => {
    const snapshot = useCustomizeInterfaceStore.getState().snapshot;
    if (!snapshot) return;
    const changed = changedCustomizeSettingKeys(
      snapshot.settings,
      pickCustomizeSettings(getClientSettings()),
    );
    if (changed.length > 0) {
      void updateSettings(Object.fromEntries(changed.map((key) => [key, snapshot.settings[key]])));
    }
    let themeChanged = false;
    for (const key of THEME_STORAGE_KEYS) {
      const value = snapshot.theme[key];
      try {
        if (window.localStorage.getItem(key) === value) continue;
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
        themeChanged = true;
      } catch {
        // Storage is unavailable; the theme stays as it is.
      }
    }
    if (themeChanged) refreshTheme();
  }, [refreshTheme, updateSettings]);
}

/** Escape leaves the mode, unless a menu or field inside it should get it first. */
function useEscapeToClose(close: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      // Some menus stay mounted while closed, so only an open popup counts.
      if (
        document.querySelector(
          '[role="listbox"][data-open], [role="menu"][data-open], [role="dialog"][data-open]',
        )
      ) {
        return;
      }
      close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close]);
}

function SurfaceOutline({
  rect,
  inset,
  radiusClassName,
  emphasis,
  visible,
}: {
  rect: Rect;
  inset: number;
  radiusClassName: string;
  emphasis: "normal" | "strong" | "receded";
  visible: boolean;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed z-[104] border transition-[opacity,box-shadow,border-color] duration-200 ease-out motion-reduce:transition-none",
        radiusClassName,
        emphasis === "strong"
          ? "border-primary ring-4 ring-primary/18"
          : "border-primary/45 ring-3 ring-primary/8",
        !visible ? "opacity-0" : emphasis === "receded" ? "opacity-35" : "opacity-100",
      )}
      style={{
        left: rect.left + inset,
        top: rect.top + inset,
        width: Math.max(0, rect.right - rect.left - inset * 2),
        height: Math.max(0, rect.bottom - rect.top - inset * 2),
      }}
    />
  );
}

const PALETTES: ReadonlyArray<{ id: PaletteId; title: string; icon: ReactNode }> = [
  { id: "threadList", title: "Thread list", icon: <PanelLeftIcon /> },
  { id: "chatHeader", title: "Header", icon: <PanelTopIcon /> },
  { id: "appearance", title: "Appearance", icon: <PaletteIcon /> },
  { id: "composer", title: "Composer", icon: <MessageSquareTextIcon /> },
];

function PaletteBody({ id, onOpenSettings }: { id: PaletteId; onOpenSettings: () => void }) {
  switch (id) {
    case "threadList":
      return <ThreadListPaletteBody />;
    case "chatHeader":
      return <ChatHeaderPaletteBody />;
    case "appearance":
      return <AppearancePaletteBody onOpenSettings={onOpenSettings} />;
    case "composer":
      return <ComposerPaletteBody />;
  }
}

function AppearanceResetAction() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const isDefault = (
    Object.keys(APPEARANCE_DEFAULTS) as Array<keyof typeof APPEARANCE_DEFAULTS>
  ).every((key) => settings[key] === APPEARANCE_DEFAULTS[key]);
  return (
    <PaletteResetButton
      label="Reset appearance to defaults (keeps your theme)"
      disabled={isDefault}
      onClick={() => void updateSettings(APPEARANCE_DEFAULTS)}
    />
  );
}

function CustomizeDock({
  visible,
  hasChanges,
  onRevert,
  onDone,
  className,
  children,
}: {
  visible: boolean;
  hasChanges: boolean;
  onRevert: () => void;
  onDone: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Customize interface"
      data-customize-dock
      className={cn(
        "dialog-glass pointer-events-auto fixed z-[106] flex flex-col overflow-hidden rounded-2xl border text-popover-foreground shadow-lg/10",
        "origin-bottom-left transition-[opacity,scale,translate] duration-200 ease-out motion-reduce:transition-opacity",
        visible ? "scale-100 opacity-100" : "pointer-events-none translate-y-1 scale-95 opacity-0",
        className,
      )}
    >
      {children}
      <div className="flex h-14 items-center gap-2.5 ps-3 pe-2.5">
        <CustomizeMark icon={<SlidersHorizontalIcon />} className="size-7 [&_svg]:size-4" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Customizing</p>
          <p aria-live="polite" className="truncate text-xs text-muted-foreground">
            {hasChanges ? "Changes apply live" : "Nothing changed yet"}
          </p>
        </div>
        <Button size="sm" variant="ghost" disabled={!hasChanges} onClick={onRevert}>
          Revert
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** Narrow windows get one sheet with a tab per palette instead of floating palettes. */
function CompactCustomizeSheet({
  visible,
  hasChanges,
  onRevert,
  onDone,
  onOpenSettings,
}: {
  visible: boolean;
  hasChanges: boolean;
  onRevert: () => void;
  onDone: () => void;
  onOpenSettings: () => void;
}) {
  const [tab, setTab] = useState<PaletteId>("appearance");
  const setFocusedSurface = useCustomizeInterfaceStore((store) => store.setFocusedSurface);
  useEffect(() => {
    setFocusedSurface(PALETTE_SURFACE[tab]);
    return () => setFocusedSurface(null);
  }, [setFocusedSurface, tab]);
  return (
    <CustomizeDock
      visible={visible}
      hasChanges={hasChanges}
      onRevert={onRevert}
      onDone={onDone}
      className="inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] max-h-[min(34rem,70dvh)] origin-bottom"
    >
      <div className="border-b border-border/70 p-2">
        <ToggleGroup
          aria-label="Customize"
          className="w-full *:flex-1"
          value={[tab]}
          onValueChange={(next) => {
            const selected = PALETTES.find((palette) => palette.id === next[0]);
            if (selected) setTab(selected.id);
          }}
        >
          {PALETTES.map((palette) => (
            <Toggle key={palette.id} value={palette.id}>
              {palette.title}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <PaletteBody id={tab} onOpenSettings={onOpenSettings} />
      </div>
    </CustomizeDock>
  );
}

/**
 * Customize interface mode: the app stays live underneath while palettes
 * float beside the surfaces they change. Everything applies immediately;
 * Revert returns to how things looked when the mode opened.
 */
export function CustomizeInterfaceOverlay({
  active,
  onExited,
}: {
  active: boolean;
  onExited: () => void;
}) {
  const close = useCustomizeInterfaceStore((store) => store.close);
  const focusedSurface = useCustomizeInterfaceStore((store) => store.focusedSurface);
  const navigate = useNavigate();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const viewport = useViewport();
  const rects = useSurfaceRects();
  const { sizes, refFor } = usePaletteSizes();
  const [manualPositions, setManualPositions] = useState<Partial<Record<PaletteId, Point>>>({});
  const hasChanges = useHasChanges();
  const revert = useRevertChanges();
  const compact = shouldUseCompactPaletteLayout({
    viewportWidth: viewport.width,
    sidebar: rects.sidebar,
    header: rects.header,
    paletteWidth: sizes.composer.width,
  });

  // Enter on the frame after mount so the transition has a start state;
  // leave by fading out, then unmount.
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [active]);
  const visible = active && entered;
  // Palettes stagger in once; after that they follow their surfaces without delay.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setSettled(true), ENTER_DURATION_MS + 200);
    return () => window.clearTimeout(timer);
  }, [visible]);
  useEffect(() => {
    if (active) return;
    const timer = window.setTimeout(onExited, prefersReducedMotion ? 0 : ENTER_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [active, onExited, prefersReducedMotion]);

  useEscapeToClose(close);

  const openSettings = useCallback(() => {
    close();
    void navigate({ to: "/settings/appearance" });
  }, [close, navigate]);

  const layout = resolvePaletteLayout({
    viewport,
    sidebar: rects.sidebar,
    header: rects.header,
    composer: rects.composer,
    sizes,
    dock: DOCK_SIZE,
  });
  const positionOf = (id: PaletteId) => manualPositions[id] ?? layout[id];
  const bodyMaxHeight = (id: PaletteId) => {
    const position = positionOf(id);
    let bottomLimit =
      viewport.height -
      PALETTE_MARGIN -
      (id === "threadList" ? DOCK_SIZE.height + PALETTE_MARGIN : 0);
    // A palette above the composer stops short of it rather than covering it.
    const composer = rects.composer;
    if (composer && !manualPositions[id] && position.y < composer.top) {
      const overlapsHorizontally =
        position.x < composer.right && position.x + sizes[id].width > composer.left;
      if (overlapsHorizontally) bottomLimit = Math.min(bottomLimit, composer.top - PALETTE_MARGIN);
    }
    return Math.max(160, bottomLimit - position.y - PALETTE_HEADER_HEIGHT);
  };

  const outlineEmphasis = (surface: CustomizeSurface) =>
    focusedSurface === null ? "normal" : focusedSurface === surface ? "strong" : "receded";

  return (
    <div data-customize-interface className="contents">
      {rects.sidebar ? (
        <SurfaceOutline
          rect={rects.sidebar}
          inset={6}
          radiusClassName="rounded-xl"
          emphasis={outlineEmphasis("threadList")}
          visible={visible}
        />
      ) : null}
      {rects.header ? (
        <SurfaceOutline
          rect={rects.header}
          inset={4}
          radiusClassName="rounded-lg"
          emphasis={outlineEmphasis("chatHeader")}
          visible={visible}
        />
      ) : null}
      {rects.composer ? (
        <SurfaceOutline
          rect={rects.composer}
          inset={-4}
          radiusClassName="rounded-4xl"
          emphasis={outlineEmphasis("composer")}
          visible={visible}
        />
      ) : null}

      {compact ? (
        <CompactCustomizeSheet
          visible={visible}
          hasChanges={hasChanges}
          onRevert={revert}
          onDone={close}
          onOpenSettings={openSettings}
        />
      ) : (
        <>
          {PALETTES.map((palette, index) => {
            const anchor = ANCHOR_FOR_SURFACE[PALETTE_SURFACE[palette.id]];
            return (
              <CustomizePalette
                key={palette.id}
                ref={refFor(palette.id)}
                surface={PALETTE_SURFACE[palette.id]}
                title={palette.title}
                icon={palette.icon}
                position={positionOf(palette.id)}
                onMove={(position) =>
                  setManualPositions((previous) => ({ ...previous, [palette.id]: position }))
                }
                visible={visible}
                enterDelayMs={settled ? 0 : 40 + index * 40}
                maxHeight={bodyMaxHeight(palette.id)}
                headerAction={palette.id === "appearance" ? <AppearanceResetAction /> : undefined}
                {...(anchor && rects[anchor] === null ? { description: "Not on this page" } : {})}
              >
                <PaletteBody id={palette.id} onOpenSettings={openSettings} />
              </CustomizePalette>
            );
          })}
          <CustomizeDock
            visible={visible}
            hasChanges={hasChanges}
            onRevert={revert}
            onDone={close}
            className="bottom-3 left-3 w-88"
          />
        </>
      )}
    </div>
  );
}
