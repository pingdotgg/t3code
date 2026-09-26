import type { BrowserSessionViewport } from "@t3tools/extension-sdk/catalogue";
import { useEffect, useState, type ReactNode } from "react";

import {
  DEVICE_TOOLBAR_HEIGHT,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_VIEWPORT_PRESETS,
  deviceViewportLayout,
  freeformFromSetting,
  presetViewport,
  rotateViewport,
  validFreeformSize,
  viewportSettingKey,
  type FixedViewport,
  type ViewportFrameLayout,
} from "./viewport.js";

const muted = "var(--t3-browser-muted-foreground, var(--muted-foreground, #667085))";
const border = "1px solid var(--t3-browser-border, var(--border, #dfe3e8))";
const chromeButton = {
  font: "inherit",
  fontSize: 12,
  lineHeight: 1,
  padding: "3px 6px",
  border,
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
} as const;
const numberInput = {
  font: "inherit",
  fontSize: 12,
  width: 52,
  padding: "2px 4px",
  border,
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
} as const;

/**
 * Measures an element with a `ResizeObserver` — the slot area's live size
 * feeds the responsive toggle default and the frame overlay geometry. Null
 * until the first observation, the same "not measured yet" state native
 * `panelRect` starts from.
 */
export function useElementSize(ref: {
  readonly current: HTMLElement | null;
}): { readonly width: number; readonly height: number } | null {
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setSize((current) =>
        current !== null && current.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * The device toolbar, overlaying the top strip of the slot area (the height
 * the host's engine view already reserves, `DEVICE_TOOLBAR_HEIGHT`). Native
 * `BrowserDeviceToolbar` semantics: a Responsive/preset picker, freeform
 * width × height inputs, rotate, and close back to fill. Every change is a
 * `sessions.resize` through `onCommit`; nothing applies optimistically, so a
 * rejected commit leaves the toolbar showing the session's last setting.
 */
export function BrowserViewportToolbar(props: {
  readonly setting: FixedViewport;
  readonly pending: boolean;
  readonly onCommit: (next: BrowserSessionViewport) => void;
}) {
  const { setting, pending, onCommit } = props;
  // An in-progress edit is keyed to the setting it was typed against: a
  // resize landing from anywhere — this view's receipt, the events stream,
  // another client — retires the edit instead of showing it against a
  // setting it no longer describes.
  const [edit, setEdit] = useState<{
    readonly key: string;
    readonly width: string;
    readonly height: string;
  } | null>(null);
  const committedKey = viewportSettingKey(setting);
  const customSize =
    edit !== null && edit.key === committedKey ? { width: edit.width, height: edit.height } : null;

  const presentedSize = customSize ?? {
    width: String(setting.width),
    height: String(setting.height),
  };
  const customWidth = Number(presentedSize.width);
  const customHeight = Number(presentedSize.height);
  const customValid = validFreeformSize(customWidth, customHeight);
  const selectedValue =
    setting._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === setting.presetId)
      ? setting.presetId
      : "responsive";

  const applyCustomSize = () => {
    if (!customValid || (customWidth === setting.width && customHeight === setting.height)) {
      setEdit(null);
      return;
    }
    onCommit({ _tag: "freeform", width: customWidth, height: customHeight });
  };

  const selectViewport = (value: string) => {
    if (value === "responsive") {
      // Already freeform: the size is the user's to edit, nothing to switch.
      if (setting._tag === "freeform") return;
      onCommit(freeformFromSetting(setting));
      return;
    }
    const preset = presetViewport(value);
    if (preset) onCommit(preset);
  };

  return (
    <div
      role="toolbar"
      aria-label="Browser device toolbar"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: DEVICE_TOOLBAR_HEIGHT,
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 6px",
        boxSizing: "border-box",
        background: "var(--t3-browser-canvas, var(--background, #fff))",
        borderBottom: border,
        overflowX: "auto",
        whiteSpace: "nowrap",
      }}
      // Commit a finished freeform edit when focus leaves the whole toolbar,
      // like native's relatedTarget check — tabbing between fields is not a
      // finished edit.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        applyCustomSize();
      }}
    >
      <select
        aria-label="Browser device preset"
        value={selectedValue}
        disabled={pending}
        onChange={(event) => selectViewport(event.target.value)}
        style={{ ...chromeButton, padding: "2px 4px" }}
      >
        <option value="responsive">Responsive</option>
        {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {`${preset.label} — ${preset.detail}`}
          </option>
        ))}
      </select>
      <form
        style={{ display: "flex", alignItems: "center", gap: 4, margin: 0 }}
        aria-label="Viewport dimensions"
        onSubmit={(event) => {
          event.preventDefault();
          applyCustomSize();
        }}
      >
        <input
          type="number"
          inputMode="numeric"
          min={PREVIEW_VIEWPORT_MIN_DIMENSION}
          max={PREVIEW_VIEWPORT_MAX_DIMENSION}
          value={presentedSize.width}
          disabled={pending}
          onFocus={() =>
            setEdit((current) =>
              current && current.key === committedKey
                ? current
                : {
                    key: committedKey,
                    width: String(setting.width),
                    height: String(setting.height),
                  },
            )
          }
          onChange={(event) =>
            setEdit((current) => ({
              key: committedKey,
              width: event.target.value,
              height:
                current && current.key === committedKey ? current.height : String(setting.height),
            }))
          }
          aria-label="Viewport width"
          aria-invalid={!customValid}
          style={numberInput}
        />
        <span aria-hidden style={{ color: muted, fontSize: 11 }}>
          ×
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={PREVIEW_VIEWPORT_MIN_DIMENSION}
          max={PREVIEW_VIEWPORT_MAX_DIMENSION}
          value={presentedSize.height}
          disabled={pending}
          onFocus={() =>
            setEdit((current) =>
              current && current.key === committedKey
                ? current
                : {
                    key: committedKey,
                    width: String(setting.width),
                    height: String(setting.height),
                  },
            )
          }
          onChange={(event) =>
            setEdit((current) => ({
              key: committedKey,
              width:
                current && current.key === committedKey ? current.width : String(setting.width),
              height: event.target.value,
            }))
          }
          aria-label="Viewport height"
          aria-invalid={!customValid}
          style={numberInput}
        />
      </form>
      <button
        type="button"
        aria-label="Rotate viewport"
        disabled={pending}
        onClick={() =>
          onCommit(
            rotateViewport(
              setting,
              customValid ? { width: customWidth, height: customHeight } : null,
            ),
          )
        }
        style={chromeButton}
      >
        ⟳
      </button>
      <button
        type="button"
        aria-label="Close device toolbar"
        disabled={pending}
        onClick={() => onCommit({ _tag: "fill" })}
        style={{ ...chromeButton, marginLeft: "auto" }}
      >
        ×
      </button>
    </div>
  );
}

/**
 * The visible device frame, painted from the same layout math the host's
 * engine view uses inside the presented slot rect, so the ring and the fit
 * percentage coincide with the composited page. `pointer-events: none`
 * keeps the overlay out of the slot's center-point occlusion probe and lets
 * pointer input fall through to the engine.
 */
export function ViewportDeviceFrame(props: {
  readonly slot: { readonly width: number; readonly height: number } | null;
  readonly setting: FixedViewport;
  readonly fallbackSlot: { readonly width: number; readonly height: number };
}): ReactNode {
  const { slot, setting, fallbackSlot } = props;
  const layout: ViewportFrameLayout = deviceViewportLayout(slot ?? fallbackSlot, setting);
  const percent = Math.round(layout.scale * 100);
  return (
    <>
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: layout.x,
          top: layout.y,
          width: layout.width,
          height: layout.height,
          border,
          borderRadius: 6,
          boxShadow: "0 1px 4px rgba(15, 23, 42, 0.18)",
          pointerEvents: "none",
          zIndex: 40,
          boxSizing: "border-box",
        }}
      />
      {layout.scale < 1 ? (
        <div
          aria-label={`Viewport scaled to ${percent}%`}
          style={{
            position: "absolute",
            left: layout.x + layout.width - 4,
            top: layout.y + layout.height + 6,
            transform: "translateX(-100%)",
            padding: "1px 6px",
            fontSize: 11,
            color: muted,
            background: "var(--t3-browser-canvas, var(--background, #fff))",
            border,
            borderRadius: 999,
            pointerEvents: "none",
            zIndex: 40,
          }}
        >
          {percent}%
        </div>
      ) : null}
    </>
  );
}
