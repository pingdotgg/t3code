import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { ConnectOnlyNotice } from "../../connection/storage";
import { appAtomRegistry } from "../../state/atom-registry";

const takeConnectOnlyEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:take-connect-only-notice",
  execute: () => ConnectOnlyNotice.pipe(Effect.flatMap((notice) => notice.take)),
});

/** Says once which saved environments went away with T3 Connect, and how to add them back. */
export function ConnectOnlyNoticeCoordinator() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads and clears a one-time notice from the stored catalog after mount
  useEffect(() => {
    let cancelled = false;
    void takeConnectOnlyEnvironments.run(appAtomRegistry, undefined).then((result) => {
      if (cancelled || result._tag !== "Success" || result.value.length === 0) return;
      const labels = result.value.map((environment) => environment.label).join(", ");
      Dialog.alert(
        "Pair these environments again",
        `${labels} connected only through T3 Connect, which was removed. Pair again directly, over your network or Tailscale, from Settings → Environments.`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
