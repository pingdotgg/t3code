import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewAnnotationPayload, ScopedThreadRef } from "@t3tools/contracts";
import type { ComposerImageAttachment } from "../composerDraftStore";

type AnnotationSender = (
  annotation: PreviewAnnotationPayload,
  image: ComposerImageAttachment | null,
) => void;
const senders = new Map<string, AnnotationSender>();

export function registerBrowserAnnotationSender(ref: ScopedThreadRef, sender: AnnotationSender) {
  const key = scopedThreadKey(ref);
  senders.set(key, sender);
  return () => {
    if (senders.get(key) === sender) senders.delete(key);
  };
}

export function submitBrowserAnnotation(
  ref: ScopedThreadRef,
  annotation: PreviewAnnotationPayload,
  image: ComposerImageAttachment | null,
) {
  senders.get(scopedThreadKey(ref))?.(annotation, image);
}
