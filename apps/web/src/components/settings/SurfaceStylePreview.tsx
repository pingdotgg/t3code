import { SURFACE_STYLES, type SurfaceStyle } from "@t3tools/contracts";

import { Button, ContentButton } from "../ui/button";

const SURFACE_STYLE_LABELS: Record<SurfaceStyle, string> = {
  "gradient-rim": "Toned aqua",
  flat: "Flat",
  "soft-gradient": "Soft gradient",
  "aqua-gloss-full": "Aqua gloss",
  "aqua-blue": "Aqua blue",
  "gradient-rim-everywhere": "Gradient rim",
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
            <span
              aria-hidden
              className="flex h-24 items-center justify-center gap-2 bg-settings-preview-fill"
              data-surface-preview={style}
              inert
            >
              <Button render={<span />} size="sm">
                Approve
              </Button>
              <Button
                render={<span />}

                size="sm"
                variant="secondary"
              >
                Button
              </Button>
            </span>
            {/* px-3 like the theme cards above, so names in a column share one line. */}
            <span className="flex items-center gap-1.5 border-t border-divider px-3 py-3">
              <span className="min-w-0 flex-1 truncate text-label text-foreground">
                {SURFACE_STYLE_LABELS[style]}
              </span>
              {style === defaultValue ? (
                <span className="shrink-0 text-meta text-dim-foreground">Default</span>
              ) : null}
            </span>
          </ContentButton>
        );
      })}
    </div>
  );
}
