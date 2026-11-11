import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { ConnectOnlyNotice } from "~/connection/storage";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { toastManager } from "./ui/toast";

const takeConnectOnlyEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:take-connect-only-notice",
  execute: () => ConnectOnlyNotice.pipe(Effect.flatMap((notice) => notice.take)),
});

/** Says once which saved environments went away with T3 Connect, and how to add them back. */
export function ConnectOnlyNoticeCoordinator() {
  const navigate = useNavigate();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads and clears a one-time notice from the stored catalog after mount
  useEffect(() => {
    let cancelled = false;
    void takeConnectOnlyEnvironments.run(appAtomRegistry, undefined).then((result) => {
      if (cancelled || result._tag !== "Success" || result.value.length === 0) return;
      const labels = result.value.map((environment) => environment.label).join(", ");
      toastManager.add({
        type: "info",
        title: "Pair these environments again",
        description: `${labels} connected only through T3 Connect, which was removed. Pair again directly, over your network or Tailscale.`,
        timeout: 0,
        actionProps: {
          children: "Add environment",
          onClick: () => void navigate({ to: "/settings/connections" }),
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);
  return null;
}
