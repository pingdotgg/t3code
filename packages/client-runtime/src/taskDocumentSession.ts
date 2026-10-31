import type { OpenTaskDocument, SaveTaskDocumentInput } from "@t3tools/contracts";

export interface TaskDocumentView<TEditorView> {
  readonly editor: TEditorView | null;
  readonly scrollTop: number;
  readonly rendered: boolean;
}

export interface TaskDocumentRecovery {
  readonly base: OpenTaskDocument;
  readonly draft: string;
  readonly disk: OpenTaskDocument;
  readonly keptDraft: boolean;
}

export interface TaskDocumentSessionState<TEditorView> {
  readonly base: OpenTaskDocument | null;
  readonly draft: string;
  readonly disk: OpenTaskDocument | null;
  readonly recovery: TaskDocumentRecovery | null;
  readonly error: string | null;
  readonly saving: boolean;
  readonly view: TaskDocumentView<TEditorView>;
}

interface TaskDocumentSave {
  readonly generation: number;
  readonly input: SaveTaskDocumentInput;
}

export class TaskDocumentSession<TEditorView = unknown> {
  private generation = 0;
  private activeSave: TaskDocumentSave | null = null;
  private listeners = new Set<() => void>();
  private state: TaskDocumentSessionState<TEditorView> = {
    base: null,
    draft: "",
    disk: null,
    recovery: null,
    error: null,
    saving: false,
    view: { editor: null, scrollTop: 0, rendered: false },
  };

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<TaskDocumentSessionState<TEditorView>>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  beginRead() {
    return ++this.generation;
  }

  acceptRead(generation: number, document: OpenTaskDocument) {
    if (generation !== this.generation || this.activeSave !== null) return;
    const { base, draft } = this.state;
    if (base === null || draft === base.contents) {
      this.update({ base: document, draft: document.contents, disk: null, error: null });
    } else {
      this.update({
        disk:
          base.revision === document.revision &&
          base.summary.locatorVersion === document.summary.locatorVersion
            ? null
            : document,
        error: null,
      });
    }
  }

  failRead(generation: number, error: string) {
    if (generation === this.generation) this.update({ error });
  }

  edit(draft: string) {
    this.update({ draft });
  }

  setView(view: Partial<TaskDocumentView<TEditorView>>) {
    this.update({ view: { ...this.state.view, ...view } });
  }

  beginSave(): TaskDocumentSave | null {
    const { base, disk, draft } = this.state;
    if (base === null || disk !== null || this.activeSave !== null || draft === base.contents) {
      return null;
    }
    const save = {
      generation: ++this.generation,
      input: {
        taskDocumentId: base.summary.taskDocumentId,
        locatorVersion: base.summary.locatorVersion,
        expectedRevision: base.revision,
        baseContents: base.contents,
        contents: draft,
      },
    };
    this.activeSave = save;
    this.update({ saving: true, error: null });
    return save;
  }

  acceptSave(save: TaskDocumentSave, document: OpenTaskDocument) {
    if (this.activeSave !== save) return;
    this.activeSave = null;
    ++this.generation;
    this.update({
      base: document,
      draft: this.state.draft === save.input.contents ? document.contents : this.state.draft,
      disk: null,
      recovery: null,
      saving: false,
      error: null,
    });
  }

  failSave(save: TaskDocumentSave, error: string) {
    if (this.activeSave !== save) return;
    this.activeSave = null;
    ++this.generation;
    this.update({ saving: false, error });
  }

  private resolveDisk(keepDraft: boolean) {
    const { base, draft, disk } = this.state;
    if (base === null || disk === null || this.activeSave !== null) return;
    ++this.generation;
    this.update({
      recovery: { base, draft, disk, keptDraft: keepDraft },
      base: disk,
      draft: keepDraft ? draft : disk.contents,
      disk: null,
      error: null,
    });
  }

  keepDraft() {
    this.resolveDisk(true);
  }

  reloadDisk() {
    this.resolveDisk(false);
  }

  /** Undoes the choice made at the conflict: back to the discarded draft, or to the disk version. */
  reverseRecovery() {
    const { recovery } = this.state;
    if (recovery === null) return;
    this.update({
      draft: recovery.keptDraft ? recovery.disk.contents : recovery.draft,
      recovery: null,
    });
  }

  dismissRecovery() {
    this.update({ recovery: null });
  }
}
