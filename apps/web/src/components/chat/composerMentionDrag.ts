import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

/**
 * Drag payload type carrying a serialized composer mention. Set on drags that
 * start in the workspace file tree so the composer can tell them apart from
 * OS file drags and plain text selections.
 */
export const COMPOSER_MENTION_DRAG_TYPE = "application/x-t3code-composer-mention";

export function composerMentionFromTreePath(treePath: string): string | null {
  const relativePath = treePath.replace(/\/+$/, "");
  if (relativePath.length === 0) {
    return null;
  }
  return serializeComposerFileLink(relativePath);
}

export function dataTransferHasComposerMention(types: ReadonlyArray<string>): boolean {
  return types.includes(COMPOSER_MENTION_DRAG_TYPE);
}

export interface ComposerMentionDragTransfer {
  readonly types: ReadonlyArray<string>;
  getData(format: string): string;
  dropEffect: string;
}

export interface ComposerMentionDragEvent {
  readonly dataTransfer: ComposerMentionDragTransfer;
  readonly nativeEvent: { stopPropagation(): void };
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * What a mention drop is allowed to do to the composer. Deliberately narrow:
 * there is no way to focus the editor from here. Focusing it synchronously
 * during the drop makes the not-yet-reconciled editor sync its stale empty
 * state back over the inserted mention; the insert path already focuses on
 * the next frame, after the editor has caught up.
 */
export interface ComposerMentionDropHost {
  insertMentionAtEnd(text: string): boolean;
  setDragActive(active: boolean): void;
  onInsertRejected(): void;
}

export interface ComposerMentionDragHandlers {
  onDragEnter(event: ComposerMentionDragEvent): void;
  onDragOver(event: ComposerMentionDragEvent): void;
  onDrop(event: ComposerMentionDragEvent): void;
}

export function makeComposerMentionDragHandlers(
  host: ComposerMentionDropHost,
): ComposerMentionDragHandlers {
  // Claim the event for the composer: React's stopPropagation only halts the
  // synthetic dispatch, so the native event must be stopped too or the
  // editor's own DOM listeners still process the drag.
  const claim = (event: ComposerMentionDragEvent): boolean => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
    return true;
  };
  return {
    onDragEnter(event) {
      if (claim(event)) {
        host.setDragActive(true);
      }
    },
    onDragOver(event) {
      if (!claim(event)) {
        return;
      }
      // The tree constrains its drags to effectAllowed "move"; naming any
      // other effect makes the browser cancel the drop without firing it.
      event.dataTransfer.dropEffect = "move";
      host.setDragActive(true);
    },
    onDrop(event) {
      if (!claim(event)) {
        return;
      }
      host.setDragActive(false);
      const mention = event.dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE);
      if (mention.length === 0) {
        return;
      }
      if (!host.insertMentionAtEnd(`${mention} `)) {
        host.onInsertRejected();
      }
    },
  };
}
