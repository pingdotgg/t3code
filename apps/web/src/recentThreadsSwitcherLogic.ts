export interface RecentThreadsSwitcherSession {
  /** Scoped thread keys frozen in visit order while the switcher is open. */
  entries: ReadonlyArray<string>;
  selectedIndex: number;
  /** Modifiers held when the switcher opened. */
  holdsCtrl: boolean;
  holdsMeta: boolean;
  holdsAlt: boolean;
  holdsShift: boolean;
  /** Physical key released to commit a binding with no held modifier. */
  triggerKey: string;
}

export function reconcileRecentThreadsSwitcherSession(
  session: RecentThreadsSwitcherSession,
  isLive: (threadKey: string) => boolean,
): RecentThreadsSwitcherSession | null {
  const entries = session.entries.filter(isLive);
  if (entries.length === 0) return null;

  const selectedKey = session.entries[session.selectedIndex];
  const liveSelectedIndex = selectedKey === undefined ? -1 : entries.indexOf(selectedKey);
  const selectedIndex =
    liveSelectedIndex === -1
      ? Math.min(Math.max(session.selectedIndex, 0), entries.length - 1)
      : liveSelectedIndex;

  if (entries.length === session.entries.length && selectedIndex === session.selectedIndex) {
    return session;
  }
  return { ...session, entries, selectedIndex };
}

export function shouldCommitRecentThreadsSwitcherOnKeyUp(
  session: RecentThreadsSwitcherSession,
  event: Pick<KeyboardEvent, "code" | "key" | "getModifierState">,
): boolean {
  const hasHeldModifier =
    session.holdsCtrl || session.holdsMeta || session.holdsAlt || session.holdsShift;
  if (!hasHeldModifier) {
    return (event.code || event.key) === session.triggerKey;
  }

  const stillHeld =
    (session.holdsCtrl && event.getModifierState("Control")) ||
    (session.holdsMeta && event.getModifierState("Meta")) ||
    (session.holdsAlt && event.getModifierState("Alt")) ||
    (session.holdsShift && event.getModifierState("Shift"));
  return !stillHeld;
}
