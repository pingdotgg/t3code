import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import type { ScheduledTaskDraft } from "./scheduledTaskDraft";

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

export function startScheduledTaskEditor(next: ScheduledTaskEditor | null): void {
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

export function readScheduledTaskEditor(
  voiceOwnerKey: string,
  defaultEditor: ScheduledTaskEditor | null,
): ScheduledTaskEditor | null {
  const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
  if (`scheduled-task:${session?.id ?? 0}` !== voiceOwnerKey) return null;
  return session ? session.current : defaultEditor;
}
