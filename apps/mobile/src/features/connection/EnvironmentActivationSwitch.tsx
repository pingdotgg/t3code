import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";
import { Switch } from "react-native";

interface PendingActivation {
  readonly previous: boolean;
  readonly requested: boolean;
}

export function EnvironmentActivationSwitch(props: {
  readonly accessibilityLabel: string;
  readonly activeTrackColor?: string;
  readonly enabled: boolean;
  readonly inactiveTrackColor?: string;
  readonly onValueChange: (enabled: boolean) => Promise<AtomCommandResult<unknown, unknown>>;
}) {
  const [pending, setPending] = useState<PendingActivation | null>(null);
  const isPending = pending !== null && props.enabled === pending.previous;
  const value = isPending ? pending.requested : props.enabled;

  const handleValueChange = useCallback(
    async (enabled: boolean) => {
      const request = { previous: props.enabled, requested: enabled };
      setPending(request);
      try {
        const result = await props.onValueChange(enabled);
        if (!AsyncResult.isSuccess(result)) {
          setPending((current) => (current === request ? null : current));
        }
      } catch {
        setPending((current) => (current === request ? null : current));
      }
    },
    [props.enabled, props.onValueChange],
  );

  return (
    <Switch
      accessibilityLabel={props.accessibilityLabel}
      disabled={isPending}
      ios_backgroundColor={props.inactiveTrackColor}
      onValueChange={(enabled) => {
        void handleValueChange(enabled);
      }}
      trackColor={{
        false: props.inactiveTrackColor,
        true: props.activeTrackColor,
      }}
      value={value}
    />
  );
}
