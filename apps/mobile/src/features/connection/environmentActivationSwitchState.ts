export interface PendingActivation {
  readonly previous: boolean;
  readonly requested: boolean;
}

export function activationSwitchPresentation(
  enabled: boolean,
  pending: PendingActivation | null,
): { readonly disabled: boolean; readonly value: boolean } {
  const isPending = pending !== null && enabled === pending.previous;
  return {
    disabled: isPending,
    value: isPending ? pending.requested : enabled,
  };
}

export function settlePendingActivation(
  current: PendingActivation | null,
  request: PendingActivation,
  succeeded: boolean,
): PendingActivation | null {
  return !succeeded && current === request ? null : current;
}

export function reconcilePendingActivation(
  current: PendingActivation | null,
  enabled: boolean,
): PendingActivation | null {
  return current !== null && enabled === current.requested ? null : current;
}
