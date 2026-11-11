import { SURFACE_STYLES, type SurfaceStyle } from "@t3tools/contracts";

import { Button, ContentButton } from "../ui/button";

const SURFACE_STYLE_LABELS: Record<SurfaceStyle, string> = {
  "gradient-rim": "Standard",
  flat: "Flat",
  "soft-gradient": "Soft",
  "aqua-gloss-full": "Gloss",
  "aqua-blue": "Accent gloss",
  "gradient-rim-everywhere": "Outline",
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
  return (
    <div aria-label="Style" className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3" role="group">
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
            <span className="max-sm:block max-sm:h-full">
              <span
                aria-hidden
                className="flex h-24 flex-col items-center justify-center gap-2 bg-settings-preview-fill sm:flex-row"
                data-surface-preview={style}
                inert
              >
                <Button render={<span />} size="sm">
                  Approve
                </Button>
                <Button render={<span />} size="sm" variant="secondary">
                  Button
                </Button>
              </span>
              {/* px-3 like the theme cards above, so names in a column share one line. */}
              <span className="flex flex-col items-start gap-1.5 border-t border-divider px-3 py-3 sm:flex-row sm:items-center">
                <span className="min-w-0 flex-1 text-label text-foreground max-sm:wrap-anywhere sm:truncate">
                  {SURFACE_STYLE_LABELS[style]}
                </span>
                {style === defaultValue ? (
                  <span className="shrink-0 text-meta text-dim-foreground">Default</span>
                ) : null}
              </span>
            </span>
          </ContentButton>
        );
      })}
    </div>
  );
}
