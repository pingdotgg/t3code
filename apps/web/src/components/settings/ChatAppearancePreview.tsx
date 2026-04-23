import { type CSSProperties } from "react";
import ChatMarkdown from "../ChatMarkdown";
import { SimpleWorkEntryRow } from "../chat/SimpleWorkEntryRow";
import { type WorkLogEntry } from "../../session-logic";

const SAMPLE_MARKDOWN = `Sure — here's the refactor:

- Extracted validation into a guard clause
- Removed two levels of nesting
- Returns \`null\` when inputs are empty

\`\`\`ts
function example(): boolean {
  return true;
}
\`\`\`
`;

const PREVIEW_BASH_ROW: WorkLogEntry = {
  id: "preview-bash",
  createdAt: "2026-04-18T09:45:00Z",
  label: "Bash",
  tone: "tool",
  command: "ls -la src/",
};

const PREVIEW_EDIT_ROW: WorkLogEntry = {
  id: "preview-edit",
  createdAt: "2026-04-18T09:45:00Z",
  label: "Edit",
  tone: "tool",
  changedFiles: ["src/components/Button.tsx"],
};

interface ChatAppearancePreviewProps {
  fontSize: number;
}

/**
 * Decorative, read-only chat mock rendered in the Appearance settings
 * panel. Reuses the real timeline's `SimpleWorkEntryRow` and `ChatMarkdown` so
 * whatever styling they carry, the preview carries too — no risk of drift.
 *
 * Every text tier the real timeline uses is exercised here so scaling is
 * visible end-to-end:
 *  - `text-chat-4xs`  — work-log section header
 *  - `text-chat-xs`   — tool-row heading (inside `SimpleWorkEntryRow`), user-bubble timestamp
 *  - `text-chat-2xs`  — tooltip command preview (inside `SimpleWorkEntryRow`)
 *  - `text-chat-3xs`  — changed-file chip (inside `SimpleWorkEntryRow`), assistant meta line
 *  - `text-chat-body` — user / assistant message bodies
 * Plus `ChatMarkdown`, whose `.chat-markdown` rules in `index.css` scale
 * via `[data-timeline-root]` — set here on the wrapper along with
 * `--chat-font-size`, mirroring what MessagesTimeline does on its rows.
 *
 * Future settings (font family, colors) will extend the prop surface.
 */
export function ChatAppearancePreview({ fontSize }: ChatAppearancePreviewProps) {
  return (
    <div
      aria-hidden
      data-timeline-root="true"
      style={{ "--chat-font-size": `${fontSize}px` } as CSSProperties}
      className="space-y-3 rounded-md border border-border/60 bg-muted/40 px-3 py-3"
    >
      <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
        <p className="mb-1.5 px-0.5 text-chat-4xs uppercase tracking-[0.16em] text-muted-foreground/55">
          Tool calls (2)
        </p>
        <div className="space-y-0.5">
          <SimpleWorkEntryRow workEntry={PREVIEW_BASH_ROW} workspaceRoot={undefined} />
          <SimpleWorkEntryRow workEntry={PREVIEW_EDIT_ROW} workspaceRoot={undefined} />
        </div>
      </div>
      <div className="flex justify-end">
        <div className="relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
          <div className="whitespace-pre-wrap wrap-break-word text-chat-body leading-relaxed text-foreground">
            Can you refactor this function to use early returns?
          </div>
          <p className="mt-1.5 text-right text-chat-xs text-muted-foreground/50">09:45</p>
        </div>
      </div>
      <div className="min-w-0 px-1 py-0.5">
        <ChatMarkdown text={SAMPLE_MARKDOWN} cwd={undefined} isStreaming={false} />
        <p className="mt-1.5 text-chat-3xs text-muted-foreground/30">Just now • 1.2s</p>
      </div>
    </div>
  );
}
