import { isMacPlatform } from "./utils";

export type MixerSelection<K> = readonly K[] | null;

const enabledKeys = <K>(keys: readonly K[], enabled: MixerSelection<K>) =>
  enabled === null ? keys : keys.filter((key) => enabled.includes(key));

const normalize = <K>(keys: readonly K[], next: readonly K[]): MixerSelection<K> =>
  next.length === keys.length ? null : next;

export function toggleMixerKey<K>(
  keys: readonly K[],
  enabled: MixerSelection<K>,
  key: K,
): MixerSelection<K> {
  const current = enabledKeys(keys, enabled);
  return normalize(
    keys,
    current.includes(key)
      ? current.filter((candidate) => candidate !== key)
      : keys.filter((candidate) => candidate === key || current.includes(candidate)),
  );
}

export function soloMixerKey<K>(
  keys: readonly K[],
  enabled: MixerSelection<K>,
  key: K,
): MixerSelection<K> {
  const current = enabledKeys(keys, enabled);
  if (current.length === 1 && current[0] === key) return null;
  return normalize(keys, [key]);
}

export function mixerRowHandlers(actions: {
  readonly toggle: () => void;
  readonly solo: () => void;
}) {
  return {
    onCheckedChange: (_checked: boolean, details: { readonly event: Event }) => {
      const event = details.event;
      // macOS turns Ctrl+click into contextmenu, and Safari may still send the click.
      if (event instanceof MouseEvent && event.ctrlKey && isMacPlatform(navigator.platform)) return;
      if (event instanceof MouseEvent && event.altKey) actions.solo();
      else actions.toggle();
    },
    onContextMenu: (event: { preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault();
      event.stopPropagation();
      actions.solo();
    },
  };
}
