import type { ScopedThreadRef } from "@t3tools/contracts";
import { usePreviewSession } from "../preview/usePreviewSession";

/** Keeps a preview session mounted for a thread. */
export function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}
