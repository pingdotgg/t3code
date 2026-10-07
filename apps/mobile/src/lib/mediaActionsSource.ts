import type { MediaReference } from "@t3tools/client-runtime/media-reference";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FileBackedComposerAttachment } from "./composerImages";

/** Authored source metadata is kept separate from temporary preview/download URLs. */
export type MediaActionsSource = {
  readonly reference?: MediaReference;
  readonly name: string;
  readonly mimeType: string;
  /** Anchors the iOS share sheet to the view that opened the menu. */
  readonly sourceIdentifier?: string;
} & (
  | { readonly uri: string }
  | { readonly attachment: FileBackedComposerAttachment }
  | {
      readonly environmentId: EnvironmentId;
      readonly threadId?: ThreadId;
      readonly resource: AssetResource;
    }
);
