// Fork: the theme studio's colour, palette and shape sections. Edits land on the theme that is
// showing; a built-in is copied into My themes first (see useStudioEditor).
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { LockIcon } from "lucide-react";

import {
  KALUWA_STATUS_SWATCHES,
  kaluwaSwatchSlotForHex,
  type KaluwaStatus,
} from "../../kaluwa/kaluwaPalette";
import { setKaluwaLook, useKaluwaLook } from "../../kaluwa/kaluwaLook";
import {
  KALUWA_STUDIO_FONTS,
  KALUWA_STUDIO_LIMITS,
  designFromPreset,
  type KaluwaStudioColorKey,
} from "../../kaluwa/kaluwaStudio";
import { updateStudioDesign, updateStudioSchemeColors } from "../../kaluwa/kaluwaStudioActions";
import {
  KaluwaLiftRow,
  KaluwaModeRow,
  KaluwaPaletteRows,
  KaluwaStyleRows,
} from "../settings/KaluwaLookSettings";
import { KaluwaSwatchPanel } from "../settings/KaluwaSwatchPanel";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  StudioColorPicker,
  StudioColorRow,
  StudioColorSwatchButton,
  StudioSliderRow,
} from "./StudioControls";
import { useStudioEditor } from "./useKaluwaStudio";

const COLOR_LABELS: Readonly<Record<KaluwaStudioColorKey, string>> = {
  bg: msg("Background"),
  chrome: msg("Titlebar and rail"),
  sidebar: msg("Sidebar", { $context: "theme color for the sidebar surface" }),
  card: msg("Panel and card"),
  composer: msg("Composer", { $context: "theme color for the message composer" }),
  fg: msg("Text"),
  muted: msg("Muted text"),
  accent: msg("Accent", { $context: "theme accent color" }),
  accentFg: msg("Text on accent"),
};

const STATUS_LABELS: Readonly<Record<KaluwaStatus, string>> = {
  working: msg("Working", { $context: "thread status" }),
  waiting: msg("Waiting", { $context: "thread status" }),
  approval: msg("Approval", { $context: "thread status: needs approval" }),
  input: msg("Input", { $context: "thread status: needs user input" }),
  failed: msg("Failed", { $context: "thread status" }),
  done: msg("Done", { $context: "thread status" }),
};

const FONT_LABELS = {
  system: msg("System", { $context: "UI font: the system font" }),
  inter: "Inter",
} as const;

function ReadOnlyNotice({ name }: { readonly name: string }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground sm:px-4">
      <LockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <p>
        <T>
          <strong className="font-medium text-foreground">
            <Var>{name}</Var>
          </strong>{" "}
          is read-only. Your first change copies it into My themes and switches to the copy.
        </T>
      </p>
    </div>
  );
}

export function StudioSurfacesSection() {
  const gt = useGT();
  const m = useMessages();
  const { studio, design, scheme, edit, sourceName } = useStudioEditor();
  const colors = design[scheme];
  const base = designFromPreset(design.base);
  return (
    <SettingsSection id="kaluwa-studio-surfaces" title={gt("Surfaces and color")}>
      {studio ? null : <ReadOnlyNotice name={sourceName} />}
      <KaluwaModeRow />
      <p className="px-3 pb-1 text-xs text-muted-foreground sm:px-4">
        {scheme === "dark"
          ? gt("Editing the dark colors. Switch Mode to edit the light ones.")
          : gt("Editing the light colors. Switch Mode to edit the dark ones.")}
      </p>
      <div className="pb-2">
        {(Object.keys(COLOR_LABELS) as KaluwaStudioColorKey[]).map((key) => (
          <StudioColorRow
            key={key}
            label={m(COLOR_LABELS[key])}
            value={colors[key]}
            onChange={(value) =>
              edit((id) => updateStudioSchemeColors(id, scheme, { [key]: value }))
            }
          />
        ))}
      </div>
      <StudioSliderRow
        id="kaluwa-studio-hairline"
        title={gt("Hairline")}
        description={gt("How strong borders and dividers are.")}
        value={colors.borderAlpha}
        limits={KALUWA_STUDIO_LIMITS.borderAlpha}
        unit="%"
        defaultValue={base[scheme].borderAlpha}
        onChange={(borderAlpha) =>
          edit((id) => updateStudioSchemeColors(id, scheme, { borderAlpha }))
        }
      />
      <StudioSliderRow
        id="kaluwa-studio-warmth"
        title={gt("Warmth")}
        description={gt("Tint every neutral toward ember (+) or steel blue (−).")}
        value={design.warmth}
        limits={KALUWA_STUDIO_LIMITS.warmth}
        step={5}
        defaultValue={0}
        onChange={(warmth) => edit((id) => updateStudioDesign(id, { warmth }))}
      />
      <StudioSliderRow
        id="kaluwa-studio-contrast"
        title={gt("Contrast", { $context: "theme setting: muted text and hairline strength" })}
        description={gt(
          "Move muted text and hairlines together, toward the text or the background.",
        )}
        value={design.contrast}
        limits={KALUWA_STUDIO_LIMITS.contrast}
        step={5}
        defaultValue={0}
        onChange={(contrast) => edit((id) => updateStudioDesign(id, { contrast }))}
      />
      <KaluwaLiftRow />
    </SettingsSection>
  );
}

function StatusPickers() {
  const gt = useGT();
  const m = useMessages();
  const { look, palette } = useKaluwaLook();
  const statuses = Object.keys(KALUWA_STATUS_SWATCHES) as KaluwaStatus[];
  const customized = Object.keys(look.statusSwatches).length > 0;
  if (look.statusColors !== "palette") return null;
  const colorOf = (status: KaluwaStatus) => {
    const pick = look.statusSwatches[status] ?? KALUWA_STATUS_SWATCHES[status];
    return pick.startsWith("#") ? pick : palette[pick as keyof typeof palette];
  };
  const pick = (status: KaluwaStatus, hex: string) => {
    const slot = kaluwaSwatchSlotForHex(hex);
    const next = { ...look.statusSwatches, [status]: slot ?? hex.toLowerCase() };
    if (slot === KALUWA_STATUS_SWATCHES[status]) delete next[status];
    setKaluwaLook({ statusSwatches: next });
  };
  return (
    <SettingsRow
      title={gt("Status picks")}
      description={gt("Pick each status color from the palette, or a custom one under Advanced.")}
      resetAction={
        customized ? (
          <SettingResetButton
            ariaLabel={gt("Reset status picks to default")}
            onClick={() => setKaluwaLook({ statusSwatches: {} })}
          />
        ) : null
      }
    >
      <div className="grid grid-cols-3 gap-2 pt-2 pb-2">
        {statuses.map((status) => {
          const label = m(STATUS_LABELS[status]);
          const color = colorOf(status);
          return (
            <div key={status} className="flex min-w-0 items-center gap-2">
              <StudioColorSwatchButton
                label={gt("Pick the {status} color", { status: label })}
                color={color}
              >
                <KaluwaSwatchPanel value={color} onCommit={(hex) => pick(status, hex)}>
                  <StudioColorPicker
                    label={label}
                    value={color}
                    onCommit={(hex) => pick(status, hex)}
                  />
                </KaluwaSwatchPanel>
              </StudioColorSwatchButton>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
            </div>
          );
        })}
      </div>
    </SettingsRow>
  );
}

export function StudioPaletteSection() {
  const gt = useGT();
  return (
    <SettingsSection id="kaluwa-studio-palette" title={gt("Palette")}>
      <KaluwaPaletteRows />
      <StatusPickers />
      <KaluwaStyleRows />
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        {gt(
          "Agent, project and machine colors are picked from this palette where each is set: providers in Settings, projects from their icon menu.",
        )}
      </p>
    </SettingsSection>
  );
}

export function StudioShapeSection() {
  const gt = useGT();
  const m = useMessages();
  const { studio, design, edit, sourceName } = useStudioEditor();
  const base = designFromPreset(design.base);
  const fontTitle = gt("UI font");
  return (
    <SettingsSection id="kaluwa-studio-shape" title={gt("Shape and type")}>
      {studio ? null : <ReadOnlyNotice name={sourceName} />}
      <StudioSliderRow
        id="kaluwa-studio-radius"
        title={gt("Panels and cards")}
        description={gt("Corner rounding of panels, cards, menus and dialogs.")}
        value={design.radius}
        limits={KALUWA_STUDIO_LIMITS.radius}
        unit="px"
        defaultValue={base.radius}
        onChange={(radius) => edit((id) => updateStudioDesign(id, { radius }))}
      />
      <StudioSliderRow
        id="kaluwa-studio-control-radius"
        title={gt("Controls")}
        description={gt("Corner rounding of buttons, fields and sidebar rows.")}
        value={design.controlRadius}
        limits={KALUWA_STUDIO_LIMITS.controlRadius}
        unit="px"
        defaultValue={base.controlRadius}
        onChange={(controlRadius) => edit((id) => updateStudioDesign(id, { controlRadius }))}
      />
      <StudioSliderRow
        id="kaluwa-studio-composer-radius"
        title={gt("Composer", { $context: "corner radius of the message composer" })}
        description={gt("Corner rounding of the message composer.")}
        value={design.composerRadius}
        limits={KALUWA_STUDIO_LIMITS.composerRadius}
        unit="px"
        defaultValue={base.composerRadius}
        onChange={(composerRadius) => edit((id) => updateStudioDesign(id, { composerRadius }))}
      />
      <StudioSliderRow
        id="kaluwa-studio-shadow"
        title={gt("Composer shadow")}
        description={gt("How far the composer lifts off the page. 0 keeps the app's own shadow.")}
        value={design.shadow}
        limits={KALUWA_STUDIO_LIMITS.shadow}
        step={5}
        unit="%"
        defaultValue={0}
        onChange={(shadow) => edit((id) => updateStudioDesign(id, { shadow }))}
      />
      <SettingsRow
        title={fontTitle}
        description={gt("The theme's interface font. A font chosen under Typography still wins.")}
        resetAction={
          design.font !== base.font ? (
            <SettingResetButton
              ariaLabel={gt("Reset {setting} to default", { setting: fontTitle })}
              onClick={() => edit((id) => updateStudioDesign(id, { font: base.font }))}
            />
          ) : null
        }
        control={
          <ToggleGroup
            aria-label={fontTitle}
            variant="segmented"
            value={[design.font]}
            onValueChange={(next) => {
              const font = KALUWA_STUDIO_FONTS.find((option) => option === next[0]);
              if (font) edit((id) => updateStudioDesign(id, { font }));
            }}
          >
            {KALUWA_STUDIO_FONTS.map((font) => (
              <Toggle key={font} value={font}>
                {font === "inter" ? FONT_LABELS.inter : m(FONT_LABELS.system)}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      />
    </SettingsSection>
  );
}
