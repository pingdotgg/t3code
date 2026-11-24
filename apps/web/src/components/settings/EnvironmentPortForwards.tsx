import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { PinIcon } from "lucide-react";

import {
  canRetryPinnedPortForward,
  pinnedPortForwardsAtom,
  retryPinnedPortForward,
  unpinPortForward,
} from "~/state/pinnedPortForwards";
import {
  pinnedPortLabel,
  pinnedPortMapping,
  pinnedPortStatusText,
} from "../preview/pinnedPortForwardCopy";
import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";

export function EnvironmentPortForwards(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const pins = useAtomValue(pinnedPortForwardsAtom).filter(
    (pin) => pin.environmentId === props.environmentId,
  );
  if (pins.length === 0) return null;

  const stop = async (remotePort: number): Promise<void> => {
    const result = await settlePromise(() => unpinPortForward(props.environmentId, remotePort));
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: gt("Could not stop auto-forwarding. Try again.") });
    }
  };

  return (
    <ul className="mt-2 grid list-none gap-2 text-xs" aria-label={gt("Auto-forwards")}>
      {pins.map((pin) => {
        const label = pinnedPortLabel(pin, messages);
        const status = pinnedPortStatusText(pin, props.environmentLabel, messages);
        const canRetry = canRetryPinnedPortForward(pin.status);
        return (
          <li key={pin.remotePort} className="flex min-w-0 items-start gap-1.5">
            <PinIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="max-w-full break-words font-medium text-foreground">{label}</span>
                <span className={canRetry ? "text-destructive" : "text-muted-foreground"}>
                  {status}
                </span>
              </div>
              <p className="break-words text-muted-foreground">
                {pinnedPortMapping(props.environmentLabel, pin.remotePort, messages)}
              </p>
              <div className="flex flex-wrap gap-x-2">
                {canRetry ? (
                  <InlineButton
                    onClick={() => retryPinnedPortForward(props.environmentId, pin.remotePort)}
                  >
                    {gt("Retry auto-forward")}
                  </InlineButton>
                ) : null}
                <InlineButton tone="muted" onClick={() => void stop(pin.remotePort)}>
                  {gt("Stop auto-forwarding")}
                </InlineButton>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
