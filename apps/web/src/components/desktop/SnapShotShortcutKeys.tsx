import type { SnapShotShortcut } from "@t3tools/contracts";
import { snapShotShortcutKeyLabels } from "../../lib/snapShotShortcut";
import { Kbd, KbdGroup } from "../ui/kbd";
import { definePluginComponent } from "~/plugins/features";

export const SnapShotShortcutKeys = definePluginComponent(
  "component:components/desktop/SnapShotShortcutKeys/SnapShotShortcutKeys",
  PluginOriginalSnapShotShortcutKeys,
);

function PluginOriginalSnapShotShortcutKeys({
  shortcut,
  platform = navigator.platform,
}: {
  shortcut: SnapShotShortcut;
  platform?: string;
}) {
  const seenLabels = new Map<string, number>();
  return (
    <KbdGroup>
      {snapShotShortcutKeyLabels(shortcut, platform).map((label) => {
        const seen = seenLabels.get(label) ?? 0;
        seenLabels.set(label, seen + 1);
        return (
          <Kbd aria-hidden key={`${label}-${seen}`}>
            {label}
          </Kbd>
        );
      })}
    </KbdGroup>
  );
}
