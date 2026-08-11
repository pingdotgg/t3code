import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";
import { Switch } from "react-native";

import {
  activationSwitchPresentation,
  reconcilePendingActivation,
  settlePendingActivation,
  type PendingActivation,
} from "./environmentActivationSwitchState";

export function EnvironmentActivationSwitch(props: {
  readonly accessibilityLabel: string;
  readonly activeTrackColor?: string;
  readonly enabled: boolean;
  readonly inactiveTrackColor?: string;
  readonly onValueChange: (enabled: boolean) => Promise<AtomCommandResult<unknown, unknown>>;
}) {
  const [pending, setPending] = useState<PendingActivation | null>(null);
  const presentation = activationSwitchPresentation(props.enabled, pending);

  useEffect(() => {
    setPending((current) => reconcilePendingActivation(current, props.enabled));
  }, [props.enabled]);

  const handleValueChange = useCallback(
    async (enabled: boolean) => {
      const request = { previous: props.enabled, requested: enabled };
      setPending(request);
      try {
        const result = await props.onValueChange(enabled);
        setPending((current) =>
          settlePendingActivation(current, request, result._tag === "Success"),
        );
      } catch {
        setPending((current) => settlePendingActivation(current, request, false));
      }
    },
    [props.enabled, props.onValueChange],
  );

  return (
    <Switch
      accessibilityLabel={props.accessibilityLabel}
      disabled={presentation.disabled}
      ios_backgroundColor={props.inactiveTrackColor}
      onValueChange={(enabled) => {
        void handleValueChange(enabled);
      }}
      trackColor={{
        false: props.inactiveTrackColor,
        true: props.activeTrackColor,
      }}
      value={presentation.value}
    />
  );
}
