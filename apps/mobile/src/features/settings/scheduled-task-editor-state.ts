import type { EnvironmentId } from "@t3tools/contracts";
import type { NavigationState, PartialState } from "@react-navigation/native";
import { Atom } from "effect/reactivity";

import { findLinkedRoute } from "../../lib/appLinking";

import { appAtomRegistry } from "../../state/atom-registry";
import { hasScheduledTaskDraftChanges, type ScheduledTaskDraft } from "./scheduledTaskDraft";

export type ScheduledTaskEditor = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly draft: ScheduledTaskDraft;
};

type ScheduledTaskEditorSession = {
  readonly id: number;
  readonly initial: ScheduledTaskEditor | null;
  readonly current: ScheduledTaskEditor | null;
};

export const scheduledTaskEditorSessionAtom = Atom.make<ScheduledTaskEditorSession | null>(
  null,
).pipe(Atom.keepAlive);
let nextEditorId = 0;
let newTaskLinkAwaitsDiscard = false;

export function scheduledTaskEditorHasChanges(
  initial: ScheduledTaskEditor | null,
  current: ScheduledTaskEditor | null,
): boolean {
  return Boolean(
    initial &&
    current &&
    (initial.environmentId !== current.environmentId ||
      hasScheduledTaskDraftChanges(initial.draft, current.draft)),
  );
}

export function startScheduledTaskEditor(next: ScheduledTaskEditor | null): void {
  newTaskLinkAwaitsDiscard = false;
  appAtomRegistry.set(scheduledTaskEditorSessionAtom, {
    id: ++nextEditorId,
    initial: next,
    current: next,
  });
}

export function updateScheduledTaskEditor(
  update:
    | ScheduledTaskEditor
    | null
    | ((current: ScheduledTaskEditor | null) => ScheduledTaskEditor | null),
  defaultEditor: ScheduledTaskEditor | null,
): void {
  const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
  const previous = session ? session.current : defaultEditor;
  appAtomRegistry.set(scheduledTaskEditorSessionAtom, {
    id: session?.id ?? 0,
    initial: session ? session.initial : previous,
    current: typeof update === "function" ? update(previous) : update,
  });
}

/**
 * A saved task is the new baseline. Without it a later new-task link reads the saved edits as
 * unsaved, keeps them under "New", and saving there would overwrite the task.
 */
export function markScheduledTaskEditorSaved(): void {
  newTaskLinkAwaitsDiscard = false;
  const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
  if (session) {
    appAtomRegistry.set(scheduledTaskEditorSessionAtom, { ...session, initial: session.current });
  }
}

export function readScheduledTaskEditor(
  voiceOwnerKey: string,
  defaultEditor: ScheduledTaskEditor | null,
): ScheduledTaskEditor | null {
  const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
  if (`scheduled-task:${session?.id ?? 0}` !== voiceOwnerKey) return null;
  return session ? session.current : defaultEditor;
}

/**
 * A new-task link starts a fresh editor, or a warm app reopens the last task's draft under
 * "New" and saves over it. Links parse before the open editor's removal guard runs, so
 * unsaved changes stay until the user discards them there.
 */
export function takeScheduledTaskNewLink(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (findLinkedRoute(state, ["SettingsScheduledTaskNew"])) {
    const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
    if (session && scheduledTaskEditorHasChanges(session.initial, session.current)) {
      newTaskLinkAwaitsDiscard = true;
    } else {
      appAtomRegistry.set(scheduledTaskEditorSessionAtom, null);
    }
  }
  return state;
}

/** Drops unsaved changes; a new-task link that waited on them then opens a fresh editor. */
export function discardScheduledTaskEditor(): void {
  if (newTaskLinkAwaitsDiscard) {
    newTaskLinkAwaitsDiscard = false;
    appAtomRegistry.set(scheduledTaskEditorSessionAtom, null);
    return;
  }
  startScheduledTaskEditor(null);
}
