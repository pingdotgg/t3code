import { PullRequestContextMetadata } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { Option, Schema } from "effect";

export const COMPOSER_MENTION_DRAG_TYPE = "application/x-t3code-composer-mention";

export const COMPOSER_PULL_REQUEST_DRAG_TYPE = "application/x-t3code-pull-request";

const PullRequestDragPayload = Schema.fromJsonString(PullRequestContextMetadata);
const decodePullRequestPayload = Schema.decodeUnknownOption(PullRequestDragPayload);

export const encodePullRequestDragPayload = Schema.encodeSync(PullRequestDragPayload);

export function composerMentionFromTreePath(treePath: string): string | null {
  const relativePath = treePath.replace(/\/+$/, "");
  if (relativePath.length === 0) {
    return null;
  }
  return serializeComposerFileLink(relativePath);
}

export function dataTransferHasComposerMention(types: ReadonlyArray<string>): boolean {
  return (
    types.includes(COMPOSER_MENTION_DRAG_TYPE) || types.includes(COMPOSER_PULL_REQUEST_DRAG_TYPE)
  );
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

/** Insertion focuses next frame; synchronous focus would overwrite the unreconciled mention. */
export interface ComposerMentionDropHost {
  insertMentionAtEnd(text: string): boolean;
  insertPullRequestAtEnd(pullRequest: PullRequestContextMetadata): boolean;
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
  // Stop native propagation so the editor cannot process claimed drags.
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
      // Tree drags allow only "move"; other drop effects cancel delivery.
      event.dataTransfer.dropEffect = "move";
      host.setDragActive(true);
    },
    onDrop(event) {
      if (!claim(event)) {
        return;
      }
      host.setDragActive(false);
      if (event.dataTransfer.types.includes(COMPOSER_PULL_REQUEST_DRAG_TYPE)) {
        const pullRequest = decodePullRequestPayload(
          event.dataTransfer.getData(COMPOSER_PULL_REQUEST_DRAG_TYPE),
        );
        if (Option.isSome(pullRequest) && !host.insertPullRequestAtEnd(pullRequest.value)) {
          host.onInsertRejected();
        }
        return;
      }
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
