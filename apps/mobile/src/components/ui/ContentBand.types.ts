import type { ReactNode } from "react";

export interface ContentBandProps {
  readonly tone?: "card" | "warning";
  /** "roomy" for a band holding a block of content, such as a raw patch. */
  readonly spacing?: "compact" | "roomy";
  readonly children: ReactNode;
}

/** A status at the top of otherwise empty content, such as "No changes" or a loading diff. */
export interface ContentStatusProps {
  readonly title?: string;
  readonly detail: string;
  readonly loading?: boolean;
}
