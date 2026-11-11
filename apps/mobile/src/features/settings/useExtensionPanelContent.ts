import { useEffect, useEffectEvent, useState } from "react";
import type { EnvironmentId, ExtensionInfo } from "@t3tools/contracts";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";

export function useExtensionPanelContent(
  environmentId: EnvironmentId,
  entry: ExtensionInfo,
  panelId: string | undefined,
) {
  const panel = useAtomCommand(extensionEnvironment.panel);
  const [state, setState] = useState<{
    data: string | null;
    error: string | null;
    isPending: boolean;
  }>({ data: null, error: null, isPending: Boolean(panelId && entry.status === "running") });
  const load = useEffectEvent(() =>
    panelId && entry.status === "running"
      ? panel({
          environmentId,
          input: { id: entry.manifest.id, panelId: panelId!, runtimeId: entry.runtimeId },
        })
      : null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads the panel document from its owning extension process generation and ignores superseded replies.
  useEffect(() => {
    let active = true;
    const result = load();
    if (!result) return;
    void result
      .then((result) => {
        const data = extensionCommandValue(result);
        if (active) setState({ data, error: null, isPending: false });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ data: null, error: extensionFailureMessage(error), isPending: false });
      });
    return () => {
      active = false;
    };
  }, []);
  return state;
}
