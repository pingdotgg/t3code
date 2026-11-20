import { FileText } from "lucide-react";
import type { ReactNode } from "react";

import { useContext } from "react";

import { ArtifactLookupContext } from "./artifactLookup";

export const CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1 rounded-md bg-hover px-1.5 align-baseline text-[12px] text-fg hover:bg-line";

/** A link or path that names an artifact, which opens it in the viewer. */
export function ArtifactLink({
  absolutePath,
  children,
}: {
  absolutePath: string;
  children: ReactNode;
}) {
  const lookup = useContext(ArtifactLookupContext);
  return (
    <button
      type="button"
      data-testid="file-link"
      data-path={absolutePath}
      onClick={() => lookup.open(absolutePath)}
      className={`${CHIP_CLASS} cursor-pointer`}
    >
      <FileText className="size-3 shrink-0 text-focus" aria-hidden />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}
