import type { PreviewAnnotationPayload, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, use } from "react";

import type { ComposerImageAttachment, DraftId } from "~/composerDraftStore";

/**
 * What the chat view lends the panel it is rendering. A panel reads this
 * instead of receiving the same values as props, so only panel-specific
 * inputs stay on its props.
 */
export interface PanelHost {
  /** Thread the panel belongs to; its environmentId scopes every server call. */
  readonly threadRef: ScopedThreadRef;
  /** False while the right panel is collapsed but the panel stays mounted. */
  readonly visible: boolean;
  /** Draft that comments and attached context land in. */
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** Changes when a turn finishes mutating the workspace, so file views can refresh. */
  readonly workspaceMutationId: string | null;
  /** Sends an annotation as its own message through the composer of the render that lent it. */
  readonly sendAnnotation: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export const PanelHostContext = createContext<PanelHost | null>(null);

export function usePanelHost(): PanelHost {
  const host = use(PanelHostContext);
  if (!host) throw new Error("usePanelHost must be used inside a panel host");
  return host;
}
