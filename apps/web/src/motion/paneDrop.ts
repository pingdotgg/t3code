let dropped = false;

export function notePaneDrop(next: boolean): void {
  dropped = next;
}

export function takePaneDrop(): boolean {
  const drop = dropped;
  dropped = false;
  return drop;
}
