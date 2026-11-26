// Fork: where Kaluwa's backdrop art shows in the app: behind the chat pane, and as the
// dithered sidebar band.
import { BackdropCanvas, type BackdropCanvasSource } from "./BackdropCanvas";
import { backdropColor, useBackdropPalette } from "./backdropPalette";
import {
  backdropOpacity,
  isGeneratedArt,
  uploadIdOfArt,
  type BackdropView,
  type KaluwaBackdropSettings,
} from "./backdropSettings";
import { useBackdropUploads, type BackdropUpload } from "./backdropUploads";
import { useKaluwaBackdropSettings } from "./useKaluwaBackdropSettings";

/** Vertical centre of the new-thread headline in the empty chat pane, as a share of its height. */
const HOME_HEADLINE_Y = 0.42;

function backdropSource(
  settings: KaluwaBackdropSettings,
  uploads: ReadonlyArray<BackdropUpload>,
): BackdropCanvasSource | null {
  if (isGeneratedArt(settings.art)) return { kind: "generated", art: settings.art };
  const uploadId = uploadIdOfArt(settings.art);
  const upload = uploadId === null ? undefined : uploads.find((item) => item.id === uploadId);
  return upload ? { kind: "upload", upload, settings: settings.image } : null;
}

/** Art behind the chat pane. Render it inside an `isolate` container, before the timeline. */
export function KaluwaMainBackdrop({ view }: { view: BackdropView }) {
  const { settings } = useKaluwaBackdropSettings();
  const { uploads } = useBackdropUploads();
  const palette = useBackdropPalette();
  const opacity = backdropOpacity(settings, view);
  const source = backdropSource(settings, uploads);
  if (opacity === 0 || !source) return null;

  return (
    <BackdropCanvas
      className="absolute inset-0 -z-10 size-full"
      source={source}
      options={{
        pattern: settings.pattern,
        shape: settings.shape,
        cell: settings.cell,
        density: settings.density,
        fade: settings.fade,
        bottom: settings.placement === "bottom",
        dock: true,
        heroY: view === "home" ? HOME_HEADLINE_Y : null,
        seed: settings.seed,
        color: backdropColor(palette, settings.colorMode, settings.swatch),
        background: palette.background,
        dark: palette.dark,
      }}
      style={{ opacity }}
    />
  );
}

export function useKaluwaSidebarBand() {
  return useKaluwaBackdropSettings().settings.band;
}

/** The sidebar header band in its dithered form. */
export function KaluwaDitherBand() {
  const { settings } = useKaluwaBackdropSettings();
  const palette = useBackdropPalette();

  return (
    <div
      aria-hidden
      className="kaluwa-dither-band pointer-events-none absolute inset-x-0 top-0 z-0 h-20 overflow-hidden"
      style={{ left: "calc(var(--kaluwa-rail-width, 0px) * -1)" }}
    >
      <BackdropCanvas
        className="size-full"
        source={{ kind: "generated", art: "waves" }}
        options={{
          pattern: "scatter",
          shape: "square",
          cell: 3,
          density: 42,
          fade: 0,
          bottom: false,
          dock: false,
          heroY: null,
          seed: settings.seed + 2,
          color: backdropColor(palette, settings.colorMode, settings.swatch),
          background: palette.background,
          dark: palette.dark,
        }}
      />
    </div>
  );
}
