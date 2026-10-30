import { PlusIcon, XIcon } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";

import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { normalizeProviderAccentColor } from "../../providerInstances";

const FALLBACK_ACCENT_COLOR = "#2563eb";

function ProviderCustomColorPanel(props: {
  readonly value: string;
  readonly onPreview: (value: string) => void;
  readonly onCommit: (value: string) => void;
}) {
  const { onCommit, onPreview } = props;
  const [hsv, setHsv] = useState(() => hexToHsv(props.value));
  const currentColor = hsvToHex(hsv.h, hsv.s, hsv.v);
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  // Pointer drags only preview and commit once on release, so a drag writes
  // settings once instead of on every pointer move. Keyboard steps commit
  // immediately because they have no release to wait for. Holds the latest
  // dragged color, or null when no drag is in progress.
  const drag = useRef<string | null>(null);
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 0) drag.current = currentColor;
  };

  const changeHsv = (nextHsv: HsvColor) => {
    setHsv(nextHsv);
    const color = hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
    if (drag.current === null) {
      onCommit(color);
      return;
    }
    drag.current = color;
    onPreview(color);
  };
  const endDrag = () => {
    const color = drag.current;
    drag.current = null;
    if (color !== null) onCommit(color);
  };

  return (
    <div className="w-56 bg-popover">
      <div onPointerDownCapture={startDrag}>
        <ColorSaturationValuePlane
          label="Accent color"
          value={hsv}
          onChange={changeHsv}
          onInteractionEnd={endDrag}
          variant="edge"
        />
      </div>
      <div className="grid gap-3 p-3">
        <div onPointerDownCapture={startDrag}>
          <ColorHueSlider
            label="Accent color hue"
            value={hsv.h}
            onChange={(h) => changeHsv({ ...hsv, h })}
            onInteractionEnd={endDrag}
          />
        </div>
        <Input
          nativeInput
          size="compact"
          value={hexDraft ?? currentColor}
          onChange={(event) => {
            const nextColor = event.currentTarget.value;
            setHexDraft(nextColor);
            if (!/^#[\da-f]{6}$/i.test(nextColor)) return;
            setHsv(hexToHsv(nextColor));
            onCommit(nextColor);
          }}
          onBlur={() => setHexDraft(null)}
          font="mono"
          aria-label="Custom hex accent color"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function ProviderCustomColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onPreview: (value: string) => void;
  readonly onCommit: (value: string) => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}) {
  const normalized = normalizeProviderAccentColor(props.value);

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            style={normalized ? { backgroundColor: normalized } : undefined}
            aria-label={`${normalized ? "Change" : "Add"} accent color for ${props.displayName}`}
          >
            {normalized ? (
              <span className="sr-only">Change accent color</span>
            ) : (
              <PlusIcon aria-hidden />
            )}
          </Button>
        }
      />
      <PopoverPopup side="bottom" align="start" sideOffset={6} padding="none">
        <ProviderCustomColorPanel
          value={normalized ?? FALLBACK_ACCENT_COLOR}
          onPreview={props.onPreview}
          onCommit={props.onCommit}
        />
        {normalized ? (
          <div className="border-t border-border/60 p-1">
            <PopoverClose
              render={
                <Button
                  type="button"
                  size="compact"
                  variant="ghost-muted"
                  className="w-full justify-start"
                  onClick={props.onClear}
                >
                  <XIcon className="size-3.5" aria-hidden />
                  Clear color
                </Button>
              }
            />
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

export function ProviderAccentColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
  readonly description?: string;
  readonly layout?: "stacked" | "inline";
}) {
  const { description, displayName, layout = "stacked", onCommit } = props;
  const value = props.value ?? "";
  // The draft shows a dragged or just-committed color only while `value` is
  // still the one it was picked against, so the persisted value (or any outside
  // change) takes over as soon as it lands. `previewing` marks a drag that has
  // not been committed yet, which closing the popover commits.
  const [draft, setDraft] = useState<{
    readonly color: string;
    readonly base: string;
    readonly previewing: boolean;
  } | null>(null);
  if (draft !== null && draft.base !== value) setDraft(null);
  const shownValue = draft !== null && draft.base === value ? draft.color : value;
  const commit = (color: string) => {
    const normalized = normalizeProviderAccentColor(color) ?? "";
    setDraft({ color: normalized, base: value, previewing: false });
    // Not deduplicated against `value`: it is stale while an earlier commit is
    // in flight, so returning to it must still be submitted.
    onCommit(normalized);
  };

  const picker = (
    <ProviderCustomColorPicker
      displayName={displayName}
      value={normalizeProviderAccentColor(shownValue)}
      onPreview={(color) =>
        setDraft({
          color: normalizeProviderAccentColor(color) ?? "",
          base: value,
          previewing: true,
        })
      }
      onCommit={commit}
      onClear={() => commit("")}
      onClose={() => {
        if (draft?.previewing && draft.base === value) commit(draft.color);
      }}
    />
  );

  if (layout === "inline") {
    return picker;
  }

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent color</span>
      {picker}
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
  );
}
