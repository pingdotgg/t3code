/**
 * A description changed by ticking its checkboxes, shown ahead of the host's copy while ticks
 * save one at a time. Host bodies from before the latest tick are `stale` and ignored; once no
 * save runs, any other host body ends the edit.
 */
export interface TaskListEdit {
  readonly stale: ReadonlyArray<string>;
  readonly to: string;
  readonly saving: boolean;
}

export function shownTaskListBody(edit: TaskListEdit | null, hostBody: string): string {
  return edit !== null && (edit.saving || edit.stale.includes(hostBody)) ? edit.to : hostBody;
}

export function taskListEditEnded(edit: TaskListEdit | null, hostBody: string): boolean {
  return edit !== null && !edit.saving && !edit.stale.includes(hostBody);
}

/** The edit once a tick turns the shown body into `body`. */
export function tickTaskListEdit(
  edit: TaskListEdit | null,
  hostBody: string,
  body: string,
): TaskListEdit {
  const shown = shownTaskListBody(edit, hostBody);
  const stale = edit !== null && shown !== hostBody ? [...edit.stale, shown] : [];
  // A tick undone before its save makes `to` a body seen before; it must still end the edit.
  return { stale: [...stale, hostBody].filter((seen) => seen !== body), to: body, saving: true };
}
