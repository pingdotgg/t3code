// Fork: what the theme studio is editing. The theme showing right now is the one edited; a
// built-in (or any theme the studio did not make) is copied into "My themes" on the first edit.
import { msg, useGT } from "gt-react";

import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import { m } from "../../i18n/messages";
import { useKaluwaLook } from "../../kaluwa/kaluwaLook";
import { type KaluwaStudioDesign } from "../../kaluwa/kaluwaStudio";
import {
  createAndApplyStudioTheme,
  designForTheme,
  type KaluwaStudioSettings,
  type KaluwaStudioSidebar,
} from "../../kaluwa/kaluwaStudioActions";
import { useKaluwaStudioThemes } from "../../kaluwa/kaluwaStudioStore";
import { useKaluwaTabsSettings } from "../../kaluwa/kaluwaTabsSettings";
import { getThemeDefinition } from "../../themePalette";
import { useKaluwaBackdropSettings } from "../kaluwaBackdrop/useKaluwaBackdropSettings";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The id of the theme drawn right now (a mix's current half), or null for the stock theme. */
function useActiveThemeId(): string | null {
  const { theme, themeHalves, resolvedTheme } = useTheme();
  const customThemes = useCustomThemes();
  const halfId = themeHalves?.[resolvedTheme];
  if (halfId) return halfId;
  return (
    customThemes.find((custom) => custom.id === theme)?.id ?? getThemeDefinition(theme)?.id ?? null
  );
}

/** The settings a studio theme captures, as they are now. */
function useStudioCapture(): KaluwaStudioSettings {
  const { look } = useKaluwaLook();
  const tabs = useKaluwaTabsSettings();
  const { settings: backdrop } = useKaluwaBackdropSettings();
  const settings = useScopedSettings();
  return {
    look,
    tabs,
    backdrop,
    sidebar: {
      kaluwaSidebarMachineIndicator: settings.kaluwaSidebarMachineIndicator,
      kaluwaSidebarSubagents: settings.kaluwaSidebarSubagents,
      kaluwaSidebarFinishedSubagents: settings.kaluwaSidebarFinishedSubagents,
      kaluwaSidebarChildAttention: settings.kaluwaSidebarChildAttention,
    },
  };
}

export function useStudioSidebarWriter(): (patch: Partial<KaluwaStudioSidebar>) => void {
  const update = useUpdateScopedSettings();
  return (patch) => update(patch);
}

export function notifyStudioSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg("Could not save your theme")),
      description: m(msg("Browser storage is unavailable, so the change was not kept.")),
    }),
  );
}

export function useStudioEditor() {
  const gt = useGT();
  const activeId = useActiveThemeId();
  const studioThemes = useKaluwaStudioThemes();
  const { resolvedTheme } = useTheme();
  const capture = useStudioCapture();
  const studio = studioThemes.find((theme) => theme.id === activeId) ?? null;
  const design: KaluwaStudioDesign = studio?.design ?? designForTheme(activeId);
  const sourceName = getThemeDefinition(activeId ?? "system")?.label ?? gt("Kaluwa today");

  /** Runs `apply` on the studio theme, copying the showing theme into My themes first if needed. */
  const edit = (apply: (id: string) => void) => {
    if (studio) {
      apply(studio.id);
      return;
    }
    try {
      const forked = createAndApplyStudioTheme({
        name: gt("{name} (edited)", { name: sourceName }),
        design,
        settings: capture,
      });
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: gt("Copied {source} into My themes", { source: sourceName }),
          description: gt("Built-in themes stay as they are. You're now editing {name}.", {
            name: forked.name,
          }),
        }),
      );
      apply(forked.id);
    } catch (error) {
      console.error("[kaluwa-studio] Could not copy the theme.", error);
      notifyStudioSaveFailure();
    }
  };

  return { activeId, studio, design, scheme: resolvedTheme, sourceName, capture, edit };
}
