import { SURFACE_STYLES, type SurfaceStyle } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import { Button, ContentButton } from "../ui/button";

const SURFACE_STYLE_LABELS: Record<SurfaceStyle, string> = {
  "gradient-rim": msg("Toned aqua", { $context: "surface style" }),
  flat: msg("Flat", { $context: "surface style" }),
  "soft-gradient": msg("Soft gradient", { $context: "surface style" }),
  "aqua-gloss-full": msg("Aqua gloss", { $context: "surface style" }),
  "aqua-blue": msg("Aqua blue", { $context: "surface style" }),
  "gradient-rim-everywhere": msg("Gradient rim", { $context: "surface style" }),
};

/**
 * The style library (pen DKf8H): one card per surface style, each painting the
 * real primary and secondary Button in that style through data-surface-preview.
 */
export function SurfaceStylePicker({
  value,
  defaultValue,
  onChange,
}: {
  readonly value: SurfaceStyle;
  readonly defaultValue: SurfaceStyle;
  readonly onChange: (style: SurfaceStyle) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div
      aria-label={gt("Style", { $context: "surface style picker" })}
      className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3"
      role="group"
    >
      {SURFACE_STYLES.map((style) => {
        const isActive = style === value;
        return (
          <ContentButton
            variant="selection-card"
            aria-pressed={isActive}
            data-surface-style-card={style}
            key={style}
            onClick={() => onChange(style)}
            type="button"
          >
            <span
              aria-hidden
              className="flex h-24 items-center justify-center gap-2 bg-settings-preview-fill"
              data-surface-preview={style}
              inert
            >
              <Button render={<span />} size="sm">
                {gt("Approve", { $context: "sample button in a style preview" })}
              </Button>
              <Button
                render={<span />}

                size="sm"
                variant="secondary"
              >
                {gt("Button", { $context: "sample button in a style preview" })}
              </Button>
            </span>
            {/* px-3 like the theme cards above, so names in a column share one line. */}
            <span className="flex items-center gap-1.5 border-t border-divider px-3 py-3">
              <span className="min-w-0 flex-1 truncate text-label text-foreground">
                {m(SURFACE_STYLE_LABELS[style])}
              </span>
              {style === defaultValue ? (
                <span className="shrink-0 text-meta text-dim-foreground">
                  {gt("Default", { $context: "marks the default choice" })}
                </span>
              ) : null}
            </span>
          </ContentButton>
        );
      })}
    </div>
  );
}
