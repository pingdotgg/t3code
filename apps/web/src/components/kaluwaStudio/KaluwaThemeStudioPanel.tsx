// Fork: Kaluwa's theme studio, a panel docked over the running app so every change shows on the
// real UI as it is made. It stays open while the user moves between threads and settings.
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { PanelLeftIcon, PanelRightIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { DEFAULT_KALUWA_LOOK, setKaluwaLook } from "../../kaluwa/kaluwaLook";
import { KALUWA_DEFAULT_THEME_ID } from "../../kaluwa/kaluwaPalette";
import { designFromPreset } from "../../kaluwa/kaluwaStudio";
import { updateStudioDesign } from "../../kaluwa/kaluwaStudioActions";
import { resetKaluwaTabsSettings } from "../../kaluwa/kaluwaTabsSettings";
import { setTheme } from "../../hooks/useTheme";
import { useKaluwaBackdropSettings } from "../kaluwaBackdrop/useKaluwaBackdropSettings";
import { KaluwaBackdropSettings } from "../settings/KaluwaBackdropSettings";
import { KaluwaSidebarSettings } from "../settings/KaluwaSidebarSettings";
import { KaluwaTabsSettings } from "../settings/KaluwaTabsSettings";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { closeKaluwaThemeStudio, useKaluwaStudioPanelStore } from "./kaluwaStudioPanelStore";
import {
  StudioPaletteSection,
  StudioShapeSection,
  StudioSurfacesSection,
} from "./StudioDesignSections";
import { StudioPresetsSection } from "./StudioPresetsSection";
import { useStudioEditor, useStudioSidebarWriter } from "./useKaluwaStudio";

// Interface and code fonts and sizes are app-wide settings with live previews, kept on the
// Appearance page rather than mounted a second time over the chat.
function StudioTypographySection() {
  const gt = useGT();
  const navigate = useNavigate();
  return (
    <SettingsSection id="kaluwa-studio-typography" title={gt("Typography")}>
      <SettingsRow
        title={gt("Fonts and sizes")}
        description={gt(
          "Interface, prompt, code and terminal fonts and their sizes. The theme's own UI font is under Shape and type.",
        )}
        control={
          <Button
            size="xs"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/appearance", hash: "typography" })}
          >
            {gt("Open Typography")}
          </Button>
        }
      />
    </SettingsSection>
  );
}

function StudioResetSection() {
  const gt = useGT();
  const { studio } = useStudioEditor();
  const { reset: resetBackdrop } = useKaluwaBackdropSettings();
  const writeSidebar = useStudioSidebarWriter();
  const [confirming, setConfirming] = useState(false);
  const resetAll = () => {
    setConfirming(false);
    setKaluwaLook(DEFAULT_KALUWA_LOOK);
    resetKaluwaTabsSettings();
    resetBackdrop();
    writeSidebar({
      kaluwaSidebarMachineIndicator: DEFAULT_UNIFIED_SETTINGS.kaluwaSidebarMachineIndicator,
      kaluwaSidebarSubagents: DEFAULT_UNIFIED_SETTINGS.kaluwaSidebarSubagents,
      kaluwaSidebarFinishedSubagents: DEFAULT_UNIFIED_SETTINGS.kaluwaSidebarFinishedSubagents,
      kaluwaSidebarChildAttention: DEFAULT_UNIFIED_SETTINGS.kaluwaSidebarChildAttention,
    });
    setTheme(KALUWA_DEFAULT_THEME_ID);
  };
  return (
    <SettingsSection id="kaluwa-studio-reset" title={gt("Reset")}>
      {studio ? (
        <SettingsRow
          title={gt("Reset this theme")}
          description={gt("Put {name}'s colors and shape back to the preset it started from.", {
            name: studio.name,
          })}
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                const { scheme: _scheme, ...base } = designFromPreset(studio.design.base);
                updateStudioDesign(studio.id, base);
              }}
            >
              {gt("Reset theme")}
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        title={gt("Reset all")}
        description={gt(
          "Back to Ember with the default look, backdrop, tabs and sidebar. My themes are kept.",
        )}
        control={
          confirming ? (
            <div className="flex gap-1.5">
              <Button size="xs" variant="destructive" onClick={resetAll}>
                {gt("Reset everything")}
              </Button>
              <Button size="xs" variant="ghost-muted" onClick={() => setConfirming(false)}>
                {gt("Cancel")}
              </Button>
            </div>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
              {gt("Reset all")}
            </Button>
          )
        }
      />
    </SettingsSection>
  );
}

export function KaluwaThemeStudioPanel() {
  const gt = useGT();
  const dock = useKaluwaStudioPanelStore((store) => store.dock);
  const setDock = useKaluwaStudioPanelStore((store) => store.setDock);
  const { studio, sourceName } = useStudioEditor();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sections = [
    { id: "kaluwa-studio-presets", label: gt("Presets") },
    { id: "kaluwa-studio-palette", label: gt("Palette") },
    { id: "kaluwa-studio-surfaces", label: gt("Colors") },
    { id: "kaluwa-studio-shape", label: gt("Shape") },
    { id: "kaluwa-studio-typography", label: gt("Typography") },
    { id: "kaluwa-backdrop", label: gt("Backdrop") },
    { id: "kaluwa-tabs", label: gt("Tabs") },
    { id: "kaluwa-sidebar", label: gt("Sidebar") },
    { id: "kaluwa-studio-reset", label: gt("Reset") },
  ];
  const otherDock = dock === "right" ? "left" : "right";
  const dockLabel = dock === "right" ? gt("Dock on the left") : gt("Dock on the right");

  return (
    <aside
      aria-label={gt("Theme studio")}
      data-dock={dock}
      className="kaluwa-studio-panel dialog-glass flex flex-col overflow-hidden rounded-xl border text-popover-foreground"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">{gt("Theme studio")}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {studio
              ? gt("Editing {name}", { name: studio.name })
              : gt("{name} (built-in, copied when you edit it)", { name: sourceName })}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={dockLabel}
                onClick={() => setDock(otherDock)}
              >
                {dock === "right" ? <PanelLeftIcon aria-hidden /> : <PanelRightIcon aria-hidden />}
              </Button>
            }
          />
          <TooltipPopup side="bottom">{dockLabel}</TooltipPopup>
        </Tooltip>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={gt("Close theme studio")}
          onClick={closeKaluwaThemeStudio}
        >
          <XIcon aria-hidden />
        </Button>
      </header>
      <nav
        aria-label={gt("Theme studio sections")}
        className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-2"
      >
        {sections.map((section) => (
          <Button
            key={section.id}
            size="micro"
            variant="ghost-muted"
            onClick={() =>
              scrollRef.current
                ?.querySelector(`#${section.id}`)
                ?.scrollIntoView({ block: "start", behavior: "smooth" })
            }
          >
            {section.label}
          </Button>
        ))}
      </nav>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="grid gap-6 px-1 py-4">
          <StudioPresetsSection />
          <StudioPaletteSection />
          <StudioSurfacesSection />
          <StudioShapeSection />
          <StudioTypographySection />
          <KaluwaBackdropSettings />
          <KaluwaTabsSettings />
          <KaluwaSidebarSettings />
          <StudioResetSection />
        </div>
      </div>
    </aside>
  );
}
