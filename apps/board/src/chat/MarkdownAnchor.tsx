import { CircleDot, FileText, GitBranch } from "lucide-react";
import type { Components } from "react-markdown";

import { openInBrowser } from "../browser/browserTabs";
import { ArtifactLink, CHIP_CLASS } from "./ArtifactLink";
import { nodeToPlainText } from "./fences";
import { useArtifactMatch } from "./artifactLookup";
import { classifyLink } from "./links";

/** A link in a reply: an artifact opens in the viewer, a page or a PR or issue in the browser panel. */
export const MarkdownAnchor: NonNullable<Components["a"]> = ({
  node: _node,
  href,
  children,
  ...props
}) => {
  const target = href === undefined ? null : classifyLink(href);
  const artifact = useArtifactMatch(target?.kind === "file" ? target.path : null);
  if (href === undefined || target === null) return <span>{children}</span>;
  if (target.kind === "file") {
    if (artifact !== null) return <ArtifactLink absolutePath={artifact}>{children}</ArtifactLink>;
    return (
      <span className={CHIP_CLASS} data-testid="file-chip">
        <FileText className="size-3 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 truncate">{children}</span>
      </span>
    );
  }
  const reference = target.kind === "pull-request" || target.kind === "issue" ? target : null;
  const Icon = target.kind === "pull-request" ? GitBranch : CircleDot;
  const written = nodeToPlainText(children);
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-link-kind={target.kind}
      className={
        reference === null
          ? "text-focus underline underline-offset-2"
          : `${CHIP_CLASS} text-focus no-underline`
      }
      onClick={(event) => {
        if (target.kind === "other") return;
        event.preventDefault();
        if (target.kind !== "anchor") openInBrowser(href);
      }}
    >
      {reference !== null && <Icon className="size-3 shrink-0" aria-hidden />}
      {reference !== null && written === href ? reference.label : children}
    </a>
  );
};
