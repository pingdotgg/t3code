import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { shortcutLabelForCommand } from "../../keybindings";
import { commandForProjectScript } from "../../projectScripts";
import { ScriptIcon } from "../projectScriptEditor";
import { Button } from "../ui/button";
import { Kbd, KbdGroup } from "../ui/kbd";
import { SettingsRow } from "./settingsLayout";

const MAC_MODIFIER_GLYPHS = new Set(["\u2303", "\u2325", "\u21e7", "\u2318"]);

/** Splits a formatted shortcut ("⌘⇧T" or "Ctrl+Shift+T") into one key cap per key. */
function shortcutKeyCaps(label: string): Array<{ cap: string; key: string }> {
  const seen = new Map<string, number>();
  return splitShortcutLabel(label).map((cap) => {
    const count = seen.get(cap) ?? 0;
    seen.set(cap, count + 1);
    return { cap, key: count === 0 ? cap : `${cap}-${count}` };
  });
}

function splitShortcutLabel(label: string): string[] {
  if (!MAC_MODIFIER_GLYPHS.has(label[0]!) && label.includes("+")) {
    const caps = label.split("+").filter(Boolean);
    if (label.endsWith("+")) caps.push("+");
    return caps;
  }
  const caps: string[] = [];
  let index = 0;
  while (index < label.length && MAC_MODIFIER_GLYPHS.has(label[index]!)) {
    caps.push(label[index]!);
    index += 1;
  }
  if (index < label.length) caps.push(label.slice(index));
  return caps;
}

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
  if (scripts.length === 0)
    return (
      <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
        No actions configured.
      </p>
    );
  return scripts.map((script) => {
    const shortcutLabel = shortcutLabelForCommand(keybindings, commandForProjectScript(script.id));
    return (
      <SettingsRow
        key={script.id}
        className="group py-2"
        leading={<ScriptIcon icon={script.icon} className="size-4 shrink-0" />}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">{script.name}</span>
            {script.runOnWorktreeCreate ? (
              <span className="shrink-0 rounded-badge border border-border/60 px-1.5 py-px text-caption text-muted-foreground">
                setup
              </span>
            ) : null}
            {script.runOnSettle ? (
              <span className="shrink-0 rounded-badge border border-border/60 px-1.5 py-px text-caption text-muted-foreground">
                on settle
              </span>
            ) : null}
            {script.previewUrl ? (
              <span className="shrink-0 rounded-badge border border-border/60 px-1.5 py-px text-caption text-muted-foreground max-sm:hidden">
                preview · desktop only
              </span>
            ) : null}
          </span>
        }
        description={<code className="block max-w-full truncate font-mono">{script.command}</code>}
        control={
          <>
            {shortcutLabel ? (
              <KbdGroup aria-label={shortcutLabel}>
                {shortcutKeyCaps(shortcutLabel).map(({ cap, key }) => (
                  <Kbd key={key}>{cap}</Kbd>
                ))}
              </KbdGroup>
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label={`Edit ${script.name}`}
              disabled={disabled}
              onClick={() => onEdit(script)}
            >
              <EllipsisIcon />
            </Button>
          </>
        }
      />
    );
  });
}
