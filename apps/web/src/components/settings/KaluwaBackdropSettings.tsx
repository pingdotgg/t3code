// Fork: the "Backdrop art" settings section for Kaluwa's generated and uploaded backdrops.
import { msg, useGT, useMessages } from "gt-react";
import { ImageUpIcon, XIcon } from "lucide-react";
import { type CSSProperties, type DragEvent, useState } from "react";

import { cn } from "~/lib/utils";
import { BackdropCanvas, type BackdropCanvasSource } from "../kaluwaBackdrop/BackdropCanvas";
import {
  backdropColor,
  useBackdropPalette,
  type BackdropPalette,
} from "../kaluwaBackdrop/backdropPalette";
import {
  BACKDROP_LIMITS,
  BACKDROP_SWATCHES,
  GENERATED_ARTS,
  uploadArtId,
  uploadIdOfArt,
  withAvailableArt,
  type BackdropSwatch,
  type GeneratedArt,
  type KaluwaBackdropSettings,
} from "../kaluwaBackdrop/backdropSettings";
import {
  addBackdropUpload,
  isImageFile,
  removeBackdropUpload,
  useBackdropUploads,
  type BackdropUpload,
} from "../kaluwaBackdrop/backdropUploads";
import { useKaluwaBackdropSettings } from "../kaluwaBackdrop/useKaluwaBackdropSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AdvancedSettings } from "./AdvancedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const ART_LABELS: Record<GeneratedArt | "none", string> = {
  horse: msg("Horse over waves"),
  herd: msg("Herd in motion"),
  waves: msg("Wave field"),
  ridges: msg("Ridges at dawn"),
  lotus: msg("Lotus"),
  moonstone: msg("Moonstone"),
  palms: msg("Palm coast"),
  contours: msg("Contours"),
  stars: msg("Constellation"),
  aurora: msg("Aurora ribbons"),
  halftone: msg("Halftone dots"),
  grain: msg("Noise grain"),
  none: msg("None", { $context: "no backdrop artwork" }),
};

const SWATCH_LABELS: Record<BackdropSwatch, string> = {
  clay: msg("Clay"),
  ochre: msg("Ochre"),
  sand: msg("Sand"),
  moss: msg("Moss"),
  sage: msg("Sage"),
  lagoon: msg("Lagoon"),
  steel: msg("Steel"),
  slate: msg("Slate"),
  dusk: msg("Dusk"),
  plum: msg("Plum"),
  rose: msg("Rose"),
  ash: msg("Ash"),
  bone: msg("Bone"),
};

const DITHER_METHOD_LABELS = {
  atkinson: msg("Atkinson (error diffusion)"),
  floyd: msg("Floyd–Steinberg (error diffusion)"),
  ordered: msg("Ordered (Bayer 8×8)"),
} as const;

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

function thumbnailOptions(
  settings: KaluwaBackdropSettings,
  palette: BackdropPalette,
  upload: boolean,
) {
  return {
    pattern: settings.pattern,
    shape: settings.shape,
    cell: 2,
    density: upload ? settings.density : Math.max(settings.density, 50),
    fade: 0,
    bottom: false,
    dock: false,
    heroY: null,
    seed: settings.seed,
    color: backdropColor(palette, settings.colorMode, settings.swatch),
    background: palette.background,
    dark: palette.dark,
  };
}

function GalleryCard({
  label,
  pressed,
  onSelect,
  source,
  settings,
  palette,
}: {
  label: string;
  pressed: boolean;
  onSelect: () => void;
  source: BackdropCanvasSource | null;
  settings: KaluwaBackdropSettings;
  palette: BackdropPalette;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onSelect}
      className="flex w-full min-w-0 flex-col gap-1 rounded-lg p-1 pb-1.5 text-left ring-1 ring-border ring-inset outline-none hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-inset"
    >
      <span className="relative block h-14 w-full overflow-hidden rounded-md bg-background">
        {source ? (
          <BackdropCanvas
            className="absolute inset-0 size-full"
            source={source}
            options={thumbnailOptions(settings, palette, source.kind === "upload")}
          />
        ) : null}
      </span>
      <span className="truncate px-1 text-xs text-muted-foreground">{label}</span>
    </button>
  );
}

function SegmentRow<V extends string>({
  title,
  description,
  value,
  options,
  onChange,
}: {
  title: string;
  description?: string;
  value: V;
  options: ReadonlyArray<readonly [V, string]>;
  onChange: (value: V) => void;
}) {
  return (
    <SettingsRow
      devicePreference
      title={title}
      description={description}
      control={
        <ToggleGroup
          aria-label={title}
          variant="segmented"
          value={[value]}
          onValueChange={(next) => {
            const picked = options.find(([option]) => option === next[0]);
            if (picked) onChange(picked[0]);
          }}
        >
          {options.map(([option, label]) => (
            <Toggle key={option} value={option}>
              {label}
            </Toggle>
          ))}
        </ToggleGroup>
      }
    />
  );
}

function SliderRow({
  title,
  description,
  value,
  limits: [min, max],
  step = 1,
  unit = "",
  onChange,
}: {
  title: string;
  description?: string;
  value: number;
  limits: readonly [number, number];
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const ratio = (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <SettingsRow
      devicePreference
      title={title}
      description={description}
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground">
            {value}
            {unit}
          </output>
          <input
            aria-label={title}
            className="settings-slider min-w-0 flex-1"
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            style={style}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
            }}
          />
        </div>
      }
    />
  );
}

export function KaluwaBackdropSettings() {
  const gt = useGT();
  const m = useMessages();
  const { settings: stored, defaults, isKaluwa, update, reset } = useKaluwaBackdropSettings();
  const { uploads, ready } = useBackdropUploads();
  const palette = useBackdropPalette();
  const [note, setNote] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const settings = withAvailableArt(stored, ready ? new Set(uploads.map((item) => item.id)) : null);
  const uploadId = uploadIdOfArt(settings.art);
  const isUpload = uploadId !== null;
  const photo = isUpload && settings.image.mode === "photo";
  const hasArt = settings.art !== "none";
  const swatches = BACKDROP_SWATCHES.filter((name) => palette.swatches[name]);
  const changed = JSON.stringify(stored) !== JSON.stringify(defaults);

  const addFile = async (file: File | undefined) => {
    if (!file || !isImageFile(file)) {
      setNote(gt("That file is not an image."));
      return;
    }
    try {
      const upload = await addBackdropUpload(file);
      update({ art: uploadArtId(upload.id) });
      setNote(
        gt("Added {name} ({width}×{height}). It stays on this device.", {
          name: upload.name,
          width: upload.width,
          height: upload.height,
        }),
      );
    } catch (error) {
      console.error("[kaluwa-backdrop] Could not add the image.", error);
      setNote(gt("That image could not be read."));
    }
  };
  const removeUpload = async (upload: BackdropUpload) => {
    await removeBackdropUpload(upload.id);
    if (settings.art === uploadArtId(upload.id)) update({ art: "none" });
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    void addFile([...event.dataTransfer.files].find(isImageFile) ?? event.dataTransfer.files[0]);
  };

  return (
    <SettingsSection
      id="kaluwa-backdrop"
      title={gt("Backdrop art")}
      headerAction={
        changed ? (
          <Button size="xs" variant="ghost-muted" onClick={reset}>
            {gt("Reset")}
          </Button>
        ) : null
      }
    >
      <div
        className={cn(
          "space-y-2 rounded-lg px-3 py-3 sm:px-4",
          dropping && "outline-2 -outline-offset-2 outline-primary outline-dashed",
        )}
        onDragEnter={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragOver={(event) => {
          if (hasFiles(event)) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={onDrop}
      >
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {GENERATED_ARTS.map((art) => (
            <GalleryCard
              key={art}
              label={m(ART_LABELS[art])}
              pressed={settings.art === art}
              onSelect={() => update({ art })}
              source={{ kind: "generated", art }}
              settings={settings}
              palette={palette}
            />
          ))}
          <GalleryCard
            label={m(ART_LABELS.none)}
            pressed={!hasArt}
            onSelect={() => update({ art: "none" })}
            source={null}
            settings={settings}
            palette={palette}
          />
          {uploads.map((upload) => (
            <div key={upload.id} className="group/upload relative min-w-0">
              <GalleryCard
                label={upload.name}
                pressed={settings.art === uploadArtId(upload.id)}
                onSelect={() => update({ art: uploadArtId(upload.id) })}
                source={{
                  kind: "upload",
                  upload,
                  settings: { ...settings.image, blur: settings.image.blur / 8 },
                }}
                settings={settings}
                palette={palette}
              />
              <span className="absolute top-2 right-2 opacity-0 group-focus-within/upload:opacity-100 group-hover/upload:opacity-100">
                <Button
                  size="icon-xs"
                  variant="media-close"
                  aria-label={gt("Remove {name}", { name: upload.name })}
                  onClick={() => void removeUpload(upload)}
                >
                  <XIcon className="size-3" />
                </Button>
              </span>
            </div>
          ))}
          <label className="flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-lg p-1 pb-1.5 ring-1 ring-border ring-inset hover:ring-foreground/25 focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset">
            <span className="grid h-14 w-full place-items-center rounded-md border border-dashed border-border text-muted-foreground">
              <ImageUpIcon aria-hidden className="size-4" />
            </span>
            <span className="truncate px-1 text-xs text-muted-foreground">
              {gt("Upload image")}
            </span>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label={gt("Upload image")}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void addFile(file);
              }}
            />
          </label>
        </div>
        <p role="status" className="text-xs text-muted-foreground">
          {dropping
            ? gt("Drop an image to use it as the backdrop.")
            : (note ??
              gt(
                "Drop an image here or use Upload image. Images are converted on this device and never leave it.",
              ))}
        </p>
      </div>

      {isUpload ? (
        <>
          <SegmentRow
            title={gt("Use image as")}
            value={settings.image.mode}
            options={[
              ["dither", gt("Dither", { $context: "use an image as dithered dots" })],
              ["photo", gt("Photo")],
            ]}
            onChange={(mode) => update({ image: { mode } })}
          />
          {photo ? (
            <>
              <SliderRow
                title={gt("Tint")}
                value={settings.image.tint}
                limits={BACKDROP_LIMITS.tint}
                unit="%"
                onChange={(tint) => update({ image: { tint } })}
              />
              <SliderRow
                title={gt("Blur")}
                value={settings.image.blur}
                limits={BACKDROP_LIMITS.blur}
                unit="px"
                onChange={(blur) => update({ image: { blur } })}
              />
              <SliderRow
                title={gt("Wash out")}
                description={gt("Blends the photo into the background so text stays readable.")}
                value={settings.image.wash}
                limits={BACKDROP_LIMITS.wash}
                step={5}
                unit="%"
                onChange={(wash) => update({ image: { wash } })}
              />
            </>
          ) : (
            <>
              <SettingsRow
                devicePreference
                title={gt("Dither method")}
                control={
                  <Select
                    value={settings.image.dither}
                    onValueChange={(value) => {
                      if (value === "atkinson" || value === "floyd" || value === "ordered") {
                        update({ image: { dither: value } });
                      }
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full sm:w-64"
                      aria-label={gt("Dither method")}
                    >
                      <SelectValue>{m(DITHER_METHOD_LABELS[settings.image.dither])}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {(["atkinson", "floyd", "ordered"] as const).map((value) => (
                        <SelectItem hideIndicator key={value} value={value}>
                          {m(DITHER_METHOD_LABELS[value])}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />
              <SliderRow
                title={gt("Threshold")}
                value={settings.image.threshold}
                limits={BACKDROP_LIMITS.threshold}
                unit="%"
                onChange={(threshold) => update({ image: { threshold } })}
              />
              <SliderRow
                title={gt("Contrast")}
                value={settings.image.contrast}
                limits={BACKDROP_LIMITS.contrast}
                step={5}
                onChange={(contrast) => update({ image: { contrast } })}
              />
              <SliderRow
                title={gt("Brightness")}
                value={settings.image.brightness}
                limits={BACKDROP_LIMITS.brightness}
                step={5}
                onChange={(brightness) => update({ image: { brightness } })}
              />
              <SettingsRow
                devicePreference
                title={gt("Invert")}
                description={gt(
                  "Light themes invert the image already so its bright parts become ink.",
                )}
                control={
                  <Switch
                    checked={settings.image.invert}
                    onCheckedChange={(checked) => update({ image: { invert: Boolean(checked) } })}
                    aria-label={gt("Invert")}
                  />
                }
              />
            </>
          )}
          <SegmentRow
            title={gt("Crop")}
            value={settings.image.fit}
            options={[
              ["fill", gt("Fill", { $context: "crop an image to fill" })],
              ["fit", gt("Fit", { $context: "show the whole image" })],
            ]}
            onChange={(fit) => update({ image: { fit } })}
          />
          <SliderRow
            title={gt("Focal point X")}
            value={settings.image.focusX}
            limits={BACKDROP_LIMITS.focus}
            unit="%"
            onChange={(focusX) => update({ image: { focusX } })}
          />
          <SliderRow
            title={gt("Focal point Y")}
            value={settings.image.focusY}
            limits={BACKDROP_LIMITS.focus}
            unit="%"
            onChange={(focusY) => update({ image: { focusY } })}
          />
        </>
      ) : null}

      {hasArt ? (
        <>
          <SliderRow
            title={gt("Opacity")}
            value={settings.opacity}
            limits={BACKDROP_LIMITS.opacity}
            unit="%"
            onChange={(opacity) => update({ opacity })}
          />
          <SliderRow
            title={gt("Fade to composer")}
            description={gt("Clears the art around the composer.")}
            value={settings.fade}
            limits={BACKDROP_LIMITS.fade}
            step={5}
            unit="%"
            onChange={(fade) => update({ fade })}
          />
          <SliderRow
            title={gt("In threads")}
            description={gt("How strongly the art shows behind an open thread.")}
            value={settings.inThreads}
            limits={BACKDROP_LIMITS.inThreads}
            step={5}
            unit="%"
            onChange={(inThreads) => update({ inThreads })}
          />
          <SegmentRow
            title={gt("Placement")}
            value={settings.placement}
            options={[
              ["full", gt("Full", { $context: "backdrop covers the whole pane" })],
              ["bottom", gt("Bottom", { $context: "backdrop in the lower part of the pane" })],
              ["home", gt("Home only", { $context: "backdrop only on the new-thread screen" })],
            ]}
            onChange={(placement) => update({ placement })}
          />
          {swatches.length > 0 ? (
            <SegmentRow
              title={gt("Colour")}
              value={settings.colorMode}
              options={[
                ["accent", gt("Accent")],
                ["swatch", gt("Palette swatch")],
              ]}
              onChange={(colorMode) => update({ colorMode })}
            />
          ) : null}
          {swatches.length > 0 && settings.colorMode === "swatch" ? (
            <SettingsRow
              devicePreference
              title={gt("Swatch")}
              control={
                <div role="radiogroup" aria-label={gt("Swatch")} className="flex flex-wrap gap-1.5">
                  {swatches.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="radio"
                      aria-checked={settings.swatch === name}
                      aria-label={m(SWATCH_LABELS[name])}
                      onClick={() => update({ swatch: name })}
                      className="size-6 rounded-full ring-1 ring-foreground/15 ring-inset outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-checked:ring-2 aria-checked:ring-foreground aria-checked:ring-inset"
                      style={{ backgroundColor: `var(--kaluwa-swatch-${name})` }}
                    />
                  ))}
                </div>
              }
            />
          ) : null}
        </>
      ) : null}

      {isKaluwa ? (
        <SegmentRow
          title={gt("Sidebar band")}
          description={gt("The artwork behind the sidebar header.")}
          value={settings.band}
          options={[
            ["wave", gt("Wave", { $context: "sidebar header artwork style" })],
            ["dither", gt("Dither", { $context: "sidebar header artwork style" })],
            ["none", gt("None", { $context: "no sidebar header artwork" })],
          ]}
          onChange={(band) => update({ band })}
        />
      ) : null}

      {hasArt && !photo ? (
        <AdvancedSettings targetIds={[]}>
          {isUpload ? null : (
            <SegmentRow
              title={gt("Dither")}
              value={settings.pattern}
              options={[
                ["scatter", gt("Scatter", { $context: "random dither pattern" })],
                ["ordered", gt("Ordered", { $context: "regular dither pattern" })],
              ]}
              onChange={(pattern) => update({ pattern })}
            />
          )}
          <SegmentRow
            title={gt("Pixel")}
            value={settings.shape}
            options={[
              ["square", gt("Square")],
              ["round", gt("Round")],
            ]}
            onChange={(shape) => update({ shape })}
          />
          <SliderRow
            title={gt("Cell size")}
            value={settings.cell}
            limits={BACKDROP_LIMITS.cell}
            unit="px"
            onChange={(cell) => update({ cell })}
          />
          <SliderRow
            title={gt("Density")}
            value={settings.density}
            limits={BACKDROP_LIMITS.density}
            unit="%"
            onChange={(density) => update({ density })}
          />
          {isUpload ? null : (
            <SliderRow
              title={gt("Variation")}
              description={gt("Reshuffles the generated pattern.")}
              value={settings.seed}
              limits={BACKDROP_LIMITS.seed}
              onChange={(seed) => update({ seed })}
            />
          )}
        </AdvancedSettings>
      ) : null}
    </SettingsSection>
  );
}
