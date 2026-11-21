import { DEFAULT_UNIFIED_SETTINGS } from "@lathe/contracts/settings";
import { useEffect } from "react";

import { EDITIONS, getEdition, type EditionDefinition } from "../../editions/editions";
import { previewEdition } from "../../editions/editionPreview";
import { cn } from "../../lib/utils";
import { StageBackdropArt } from "../SidebarStageBackdrop";
import { LatheWordmark } from "../LatheWordmark";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Appearance section that picks the fork's stage artwork. Hovering or focusing a card previews
 * it on the real sidebar header and send button; clicking saves it.
 */
export function EditionSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  // Leaving the page mid-browse must not strand a preview.
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- clears the global edition preview on unmount so leaving mid-hover does not strand it
  useEffect(() => () => previewEdition(null), []);

  return (
    <SettingsSection
      id="appearance-edition"
      title="Edition"
      headerAction={
        settings.edition !== DEFAULT_UNIFIED_SETTINGS.edition ? (
          <SettingResetButton
            ariaLabel="Reset edition to default"
            onClick={() => updateSettings({ edition: DEFAULT_UNIFIED_SETTINGS.edition })}
          />
        ) : null
      }
    >
      <div
        {...searchableSetting("edition")}
        aria-label="Edition"
        className="grid grid-cols-2 gap-3 px-3 py-3 sm:grid-cols-4 sm:px-4"
        role="group"
      >
        {EDITIONS.map((edition) => (
          <EditionCard
            key={edition.id}
            edition={edition}
            isActive={settings.edition === edition.id}
            onSelect={() => {
              previewEdition(null);
              updateSettings({ edition: edition.id });
            }}
          />
        ))}
      </div>
      {hasDesktopBridge ? (
        <SettingsRow
          {...searchableSetting("edition-app-icon")}
          description="Show the edition's icon in the dock or taskbar while the app runs."
          resetAction={
            settings.editionAppIcon !== DEFAULT_UNIFIED_SETTINGS.editionAppIcon ? (
              <SettingResetButton
                ariaLabel="Reset match app icon to default"
                onClick={() =>
                  updateSettings({ editionAppIcon: DEFAULT_UNIFIED_SETTINGS.editionAppIcon })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.editionAppIcon}
              onCheckedChange={(checked) => updateSettings({ editionAppIcon: Boolean(checked) })}
              aria-label="Match app icon to the edition"
            />
          }
        />
      ) : null}
      <SettingsRow
        {...searchableSetting("edition-accent")}
        description={`Tint the open thread and the send button with the edition's color. ${getEdition(settings.edition).label} uses this one.`}
        resetAction={
          settings.editionAccent !== DEFAULT_UNIFIED_SETTINGS.editionAccent ? (
            <SettingResetButton
              ariaLabel="Reset edition accent to default"
              onClick={() =>
                updateSettings({ editionAccent: DEFAULT_UNIFIED_SETTINGS.editionAccent })
              }
            />
          ) : null
        }
        control={
          <span className="flex items-center gap-3">
            <span
              aria-hidden
              className="size-3 rounded-full"
              style={{ backgroundColor: getEdition(settings.edition).accent }}
            />
            <Switch
              checked={settings.editionAccent}
              onCheckedChange={(checked) => updateSettings({ editionAccent: Boolean(checked) })}
              aria-label="Use edition accent"
            />
          </span>
        }
      />
    </SettingsSection>
  );
}

/** About row naming the edition this install shows. */
export function AboutEditionRow() {
  const edition = getEdition(useScopedSettings().edition);
  return (
    <SettingsRow
      title="Edition"
      description={`${edition.label}: ${edition.description.toLowerCase()}. Change it in Appearance.`}
      control={<img alt="" className="size-7 rounded-md" draggable={false} src={edition.iconUrl} />}
    />
  );
}

function EditionCard({
  edition,
  isActive,
  onSelect,
}: {
  edition: EditionDefinition;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={isActive}
      className={cn(
        "flex cursor-pointer flex-col overflow-hidden rounded-xl border text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isActive
          ? "border-transparent bg-accent/30"
          : "border-border/70 bg-card/60 hover:bg-accent/10",
      )}
      data-edition-card={edition.id}
      style={isActive ? { boxShadow: `inset 0 0 0 1.5px ${edition.accent}` } : undefined}
      type="button"
      onBlur={() => previewEdition(null)}
      onClick={onSelect}
      onFocus={() => previewEdition(edition.id)}
      onPointerEnter={() => previewEdition(edition.id)}
      onPointerLeave={() => previewEdition(null)}
    >
      <span className="relative block h-12 overflow-hidden" aria-hidden>
        <span className="absolute inset-x-0 top-0 block h-16">
          <StageBackdropArt edition={edition.id} />
        </span>
        <span className="absolute inset-y-0 left-2.5 flex items-center text-xs text-white">
          <LatheWordmark caretClassName="text-white/70" className="h-[2cap] w-auto shrink-0" />
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2 px-2.5 py-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium text-foreground">{edition.label}</span>
          <span className="truncate text-2xs text-muted-foreground">{edition.description}</span>
        </span>
        <img
          alt=""
          className="size-6 shrink-0 rounded-md"
          draggable={false}
          src={edition.iconUrl}
        />
      </span>
    </button>
  );
}
