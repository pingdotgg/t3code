import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { SettingsIcon } from "lucide-react";
import { shortcutLabelForCommand } from "../../keybindings";
import { commandForProjectScript } from "../../projectScripts";
import { ScriptIcon } from "../projectScriptEditor";
import { Button } from "../ui/button";
import { useT } from "../../hooks/useI18n";
import { SettingsRow } from "./settingsLayout";

export function ProjectActionsList({
  scripts,
  keybindings,
  disabled,
  onEdit,
}: {
  scripts: readonly ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  disabled: boolean;
  onEdit: (script: ProjectScript) => void;
}) {
  const t = useT();
  if (scripts.length === 0)
    return (
      <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
        {t("settings.code.projectActions.empty")}
      </p>
    );
  return scripts.map((script) => {
    const shortcutLabel = shortcutLabelForCommand(keybindings, commandForProjectScript(script.id));
    return (
      <SettingsRow
        key={script.id}
        className="group py-2"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <ScriptIcon icon={script.icon} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{script.name}</span>
            {script.runOnWorktreeCreate ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
                {t("settings.code.projectActions.badgeSetup")}
              </span>
            ) : null}
            {script.runOnSettle ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
                {t("settings.code.projectActions.badgeOnSettle")}
              </span>
            ) : null}
            {script.previewUrl ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground max-sm:hidden">
                {t("settings.code.projectActions.badgePreviewDesktop")}
              </span>
            ) : null}
          </span>
        }
        description={<code className="block max-w-full truncate font-mono">{script.command}</code>}
        control={
          <>
            {shortcutLabel ? (
              <span className="text-xs text-muted-foreground">{shortcutLabel}</span>
            ) : null}
            <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={t("settings.code.projectActions.editAria", { name: script.name })}
                disabled={disabled}
                onClick={() => onEdit(script)}
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            </span>
          </>
        }
      />
    );
  });
}
