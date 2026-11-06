import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderConsumeResetCreditInput,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { resetCreditTargetKey } from "@t3tools/shared/usageLimits";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";

export function ResetWhenEmpty({
  environmentId,
  target,
  window,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ProviderConsumeResetCreditInput;
  readonly window: ServerProviderUsageWindow;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const canManage = useAtomValue(serverEnvironment.setResetWhenEmpty.permissionAtom(environmentId));
  const set = useAtomCommand(serverEnvironment.setResetWhenEmpty, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const armed =
    settings?.resetCreditsWhenEmpty?.some(
      (entry) =>
        resetCreditTargetKey(entry.target) === resetCreditTargetKey(target) &&
        entry.windowId === window.id &&
        entry.resetsAt === window.resetsAt,
    ) ?? false;
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setFailed(false);
    const result = await set({ environmentId, input: { target, windowId: window.id, enabled } });
    setBusy(false);
    setFailed(result._tag !== "Success");
  };
  return (
    <div className="mt-2 flex flex-col gap-1">
      <label className="flex items-center justify-between gap-3 text-foreground">
        Reset when empty
        <Switch
          size="sm"
          checked={armed}
          disabled={busy || !canManage || !window.resetsAt}
          onCheckedChange={(enabled) => void toggle(enabled)}
        />
      </label>
      <span>Uses one credit at 0% left, then turns off. Cancels when this period resets.</span>
      {failed ? (
        <span role="alert">Could not change the queued reset. Refresh usage and try again.</span>
      ) : null}
    </div>
  );
}
