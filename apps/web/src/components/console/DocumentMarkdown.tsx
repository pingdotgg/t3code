import { memo } from "react";

import ChatMarkdown from "../ChatMarkdown";

interface DocumentMarkdownProps {
  text: string;
  cwd: string | undefined;
  onOpenWorkspaceFile?: (path: string) => boolean | void;
}

/**
 * Doc-tuned markdown renderer for the workspace viewer. Wraps `ChatMarkdown`
 * (so all of its file-link, code-highlighting, and url-transform behavior
 * carries over) and applies a `.document-markdown` outer class. The typography
 * overrides — larger base text, real heading sizes, generous prose spacing —
 * live in `index.css` keyed off that class.
 *
 * Phase 2 deliberately re-uses ChatMarkdown rather than duplicating the
 * react-markdown setup. If we later need viewer-only behaviors (e.g. a
 * different code block treatment for documents), the cheapest split is to
 * extract a shared `useMarkdownComponents()` hook.
 */
function DocumentMarkdown({ text, cwd, onOpenWorkspaceFile }: DocumentMarkdownProps) {
  return (
    <div className="document-markdown">
      <ChatMarkdown
        text={text}
        cwd={cwd}
        {...(onOpenWorkspaceFile ? { onOpenWorkspaceFile } : {})}
      />
    </div>
  );
}

export default memo(DocumentMarkdown);
