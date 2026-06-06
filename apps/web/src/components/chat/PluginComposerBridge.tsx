import type { PluginComposerApi, PluginComposerSnapshot } from "@t3tools/plugin-api/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PluginComposerActions,
  type PluginComposerActionStateChange,
} from "../../plugins/pluginComposerActions";

type PluginComposerActionStateMap = Record<
  string,
  NonNullable<PluginComposerActionStateChange["state"]>
>;

function sameActionState(
  left: PluginComposerActionStateMap[string] | undefined,
  right: NonNullable<PluginComposerActionStateChange["state"]>,
): boolean {
  return (
    left !== undefined &&
    left.blocksSend === right.blocksSend &&
    left.label === right.label &&
    left.blockingReason === right.blockingReason
  );
}

export function usePluginComposerBridge(composerId: string) {
  const [actionStates, setActionStates] = useState<PluginComposerActionStateMap>({});
  const composerIdRef = useRef(composerId);
  composerIdRef.current = composerId;

  useEffect(() => {
    setActionStates((current) => (Object.keys(current).length === 0 ? current : {}));
  }, [composerId]);

  const onActionStateChange = useCallback((event: PluginComposerActionStateChange) => {
    if (event.composerId !== composerIdRef.current) return;
    setActionStates((current) => {
      if (event.state === null) {
        if (!(event.actionKey in current)) return current;
        const next = { ...current };
        delete next[event.actionKey];
        return next;
      }
      if (sameActionState(current[event.actionKey], event.state)) {
        return current;
      }
      return { ...current, [event.actionKey]: event.state };
    });
  }, []);

  const sendBlock =
    Object.values(actionStates).find((actionState) => actionState.blocksSend) ?? null;

  return {
    blockingReason: sendBlock?.blockingReason ?? sendBlock?.label ?? null,
    onActionStateChange,
  };
}

export function usePluginComposerApi(input: {
  readonly composerId: string;
  readonly insertText: (text: string) => boolean;
  readonly focus: () => void;
  readonly readSnapshot: () => PluginComposerSnapshot;
}): Omit<PluginComposerApi, "setActionState"> {
  return useMemo(
    () => ({
      composerId: input.composerId,
      insertText: input.insertText,
      focus: input.focus,
      readSnapshot: input.readSnapshot,
    }),
    [input.composerId, input.focus, input.insertText, input.readSnapshot],
  );
}

export function PluginComposerBridge({
  composer,
  position,
  onActionStateChange,
}: {
  readonly composer: Omit<PluginComposerApi, "setActionState">;
  readonly position: "composer.footer.left";
  readonly onActionStateChange: (event: PluginComposerActionStateChange) => void;
}) {
  return (
    <PluginComposerActions
      position={position}
      composer={composer}
      onActionStateChange={onActionStateChange}
    />
  );
}
