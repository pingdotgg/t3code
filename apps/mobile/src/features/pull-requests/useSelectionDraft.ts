import {
  draftChanges,
  isDraftSelected,
  toggleDraft,
  type SelectionDraft,
} from "@t3tools/client-runtime/pull-request-selection";
import { useEffect, useEffectEvent, useState } from "react";

/** Picks stay local while the sheet is open and go to the host once, when it closes. */
export function useSelectionDraft<T>(input: {
  // Losing write access with the sheet open drops the picks, as the web picker does.
  readonly allowed: boolean;
  readonly candidates: ReadonlyArray<T>;
  readonly candidateKey: (candidate: T) => string;
  readonly isSelected: (candidate: T) => boolean;
  readonly single: boolean;
  readonly commit: (changes: {
    readonly add: ReadonlyArray<T>;
    readonly remove: ReadonlyArray<T>;
  }) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SelectionDraft>(new Map());
  // Rows toggled from a host search, which leave the list once the query changes.
  const [picked, setPicked] = useState<ReadonlyMap<string, T>>(new Map());
  const listedKeys = new Set(input.candidates.map(input.candidateKey));
  const selections = [
    ...input.candidates,
    ...[...picked].flatMap(([key, candidate]) => (listedKeys.has(key) ? [] : [candidate])),
  ].map((candidate) => ({
    key: input.candidateKey(candidate),
    selected: input.isSelected(candidate),
    candidate,
  }));
  const send = useEffectEvent(() => {
    if (!input.allowed) return;
    const changes = draftChanges(draft, selections);
    if (changes.add.length === 0 && changes.remove.length === 0) return;
    void input.commit({
      add: changes.add.map((selection) => selection.candidate),
      remove: changes.remove.map((selection) => selection.candidate),
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the sheet closing sends the picks
  useEffect(() => () => send(), []);
  return {
    isSelected: (candidate: T) =>
      isDraftSelected(draft, {
        key: input.candidateKey(candidate),
        selected: input.isSelected(candidate),
      }),
    toggle: (candidate: T) => {
      const toggled = selections.find((selection) => selection.candidate === candidate);
      if (!toggled) return;
      setDraft(toggleDraft(draft, selections, toggled, input.single));
      setPicked(new Map(picked).set(toggled.key, toggled.candidate));
    },
  };
}
