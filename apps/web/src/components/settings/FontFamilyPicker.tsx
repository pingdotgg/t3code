import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isMonospaceFamily, queryInstalledFontFamilies } from "../../appearanceFonts";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { selectTriggerVariants } from "../ui/select";

const DEFAULT_FONT_VALUE = "__default__";

function supportsFontEnumeration(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === "function"
  );
}

type FontEnumerationState =
  | { readonly status: "unknown" }
  | { readonly status: "granted"; readonly families: readonly string[] }
  | { readonly status: "unavailable" };

// Shared across every row: once one picker learns the fonts (or learns the
// permission is blocked), the others follow without re-querying — and the
// rows can swap to the plain-input control together.
let enumerationState: FontEnumerationState = supportsFontEnumeration()
  ? { status: "unknown" }
  : { status: "unavailable" };
const enumerationListeners = new Set<() => void>();

function subscribeToEnumeration(listener: () => void): () => void {
  enumerationListeners.add(listener);
  return () => enumerationListeners.delete(listener);
}

function readEnumerationState(): FontEnumerationState {
  return enumerationState;
}

let enumerationLoad: Promise<void> | null = null;

/** Query installed fonts; call from a user gesture (the permission prompt needs one). */
export function discoverInstalledFonts(): void {
  if (enumerationState.status !== "unknown" || enumerationLoad !== null) return;
  enumerationLoad = queryInstalledFontFamilies().then((result) => {
    enumerationState =
      result.status === "granted"
        ? { status: "granted", families: result.families }
        : { status: "unavailable" };
    enumerationLoad = null;
    for (const listener of enumerationListeners) listener();
  });
}

let grantedProbeStarted = false;

/**
 * Discover eagerly when the permission is already granted, so the picker
 * renders without waiting for a focus. Electron's default permission handler
 * approves silently (it has no prompt UI), and a browser that granted once
 * reports "granted" on later visits — in both, no user gesture is needed.
 * "prompt" and "denied" states change nothing: the focus-driven flow stays,
 * because raising the browser prompt still requires a gesture.
 */
function probeAlreadyGrantedPermission(): void {
  if (grantedProbeStarted || enumerationState.status !== "unknown") return;
  grantedProbeStarted = true;
  const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
  if (typeof permissions?.query !== "function") return;
  permissions.query({ name: "local-fonts" as PermissionName }).then(
    (status) => {
      if (status.state === "granted") discoverInstalledFonts();
    },
    () => {
      // The engine does not recognize the permission name; keep the
      // focus-driven flow.
    },
  );
}

/**
 * Whether the engine can list installed fonts (Local Font Access API —
 * Chromium and Electron). "unknown" until discovery resolves the permission;
 * rows render a plain family-name input until the state is known granted,
 * then upgrade to the picker. Where the permission is already granted,
 * discovery starts at mount and the picker appears without a focus.
 */
export function useFontEnumeration(): FontEnumerationState {
  useEffect(probeAlreadyGrantedPermission, []);
  return useSyncExternalStore(subscribeToEnumeration, readEnumerationState);
}

/**
 * A searchable picker over every installed family, the way native editors
 * list system fonts. The trigger always names the font in use: the committed
 * family, or what the default stack resolves to on this machine.
 */
export function FontFamilyPicker({
  ariaLabel,
  defaultFamily,
  selectedFamily,
  requireMonospace = false,
  initialOpen = false,
  onSelect,
}: {
  ariaLabel: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  /** Committed family name; empty string means the default is in use. */
  selectedFamily: string;
  requireMonospace?: boolean;
  /** Open the popup on mount — set when the control upgrades under focus. */
  initialOpen?: boolean;
  onSelect: (family: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Open after mount rather than mounting open: a popup that first renders in
  // its open state never receives Base UI's entrance style baseline, so the
  // exit transition on close has no style delta, never fires transitionend,
  // and the popup lingers on screen forever.
  useEffect(() => {
    if (initialOpen) setOpen(true);
    // The prop is only meaningful at mount - the control just swapped in
    // under an active focus - so later changes are deliberately ignored.
  }, []);
  const listRef = useRef<LegendListRef | null>(null);
  const enumeration = useFontEnumeration();

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setQuery("");
  };

  const families = useMemo(() => {
    if (enumeration.status !== "granted") return [];
    return requireMonospace ? enumeration.families.filter(isMonospaceFamily) : enumeration.families;
  }, [enumeration, requireMonospace]);

  const items = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    const result: string[] = [];
    if (trimmedQuery.length === 0) result.push(DEFAULT_FONT_VALUE);
    result.push(
      ...families.filter(
        (family) => trimmedQuery.length === 0 || family.toLowerCase().includes(trimmedQuery),
      ),
    );
    return result;
  }, [query, families]);

  const selectedValue = selectedFamily.length === 0 ? DEFAULT_FONT_VALUE : selectedFamily;

  const handlePick = (value: string) => {
    setOpen(false);
    onSelect(value === DEFAULT_FONT_VALUE ? "" : value);
  };

  const renderItem = (item: string, index: number) => {
    const isDefault = item === DEFAULT_FONT_VALUE;
    const family = isDefault ? defaultFamily : item;
    return (
      <ComboboxItem hideIndicator index={index} key={item} value={item}>
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate" style={{ fontFamily: family }}>
            {family}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {isDefault ? (
              <span className="text-[10px] text-muted-foreground/60">default</span>
            ) : null}
            {item === selectedValue ? (
              <CheckIcon className="size-3.5 text-muted-foreground" />
            ) : null}
          </span>
        </div>
      </ComboboxItem>
    );
  };

  return (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      virtualized
      open={open}
      onOpenChange={handleOpenChange}
      value={selectedValue}
      onValueChange={(next) => {
        if (typeof next === "string") handlePick(next);
      }}
      onItemHighlighted={(_value, eventDetails) => {
        // Keyboard highlights must pull the virtualized row into view, or
        // arrow keys walk past the rendered window and navigate blind.
        if (!open || eventDetails.index < 0 || eventDetails.reason !== "keyboard") return;
        void listRef.current?.scrollIndexIntoView?.({ index: eventDetails.index, animated: false });
      }}
    >
      <ComboboxTrigger aria-label={ariaLabel} className={selectTriggerVariants({ size: "sm" })}>
        <span className="min-w-0 truncate">
          {selectedFamily.length === 0 ? defaultFamily : selectedFamily}
        </span>
        <ChevronDownIcon className="-me-1 size-3 opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="flex w-72 flex-col">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder="Search fonts…"
              showTrigger={false}
              size="sm"
              unstyled
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>No fonts found.</ComboboxEmpty>
          <div className="relative min-h-0 max-h-72 w-full flex-1 overflow-hidden">
            <ComboboxListVirtualized className="size-full min-w-0 p-0">
              <LegendList<string>
                ref={listRef}
                data={items}
                keyExtractor={(item) => item}
                renderItem={({ item, index }) => renderItem(item, index)}
                estimatedItemSize={30}
                drawDistance={360}
                style={{ height: Math.min(items.length * 30, 288) }}
              />
            </ComboboxListVirtualized>
          </div>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
