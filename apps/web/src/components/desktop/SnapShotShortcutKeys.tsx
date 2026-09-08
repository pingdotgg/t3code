import type { SnapShotShortcut } from "@t3tools/contracts";
import { snapShotShortcutKeyLabels } from "../../lib/snapShotShortcut";
import { Kbd, KbdGroup } from "../ui/kbd";

export function SnapShotShortcutKeys({
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
          <Kbd aria-hidden className="min-w-6 justify-center px-1.5" key={`${label}-${seen}`}>
            {label}
          </Kbd>
        );
      })}
    </KbdGroup>
  );
}
