import { useState } from "react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { usePullRequestReviewStore } from "./pullRequestReviewStore";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

/**
 * Edits a description or posted remark. Its scoped session draft survives panel dismissal;
 * the caller clears the accepted snapshot only after the host confirms the save.
 *
 * Preview renders through the same component the saved body will be read through, which is the
 * only way to see what a host's markdown will actually become before it is sent.
 */
export function PullRequestMarkdownEditor({
  value,
  draftKey,
  cwd,
  environmentId,
  threadRef = null,
  placeholder,
  label,
  saving,
  allowEmpty = false,
  className,
  onSave,
  onCancel,
}: {
  readonly value: string;
  readonly draftKey: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  /** Thread the editor sits beside, so links in its preview follow the link target setting. */
  readonly threadRef?: ScopedThreadRef | null;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly saving: boolean;
  /** A description may be cleared, which is how one is removed; a remark may not be emptied. */
  readonly allowEmpty?: boolean;
  readonly className?: string | undefined;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const draft = usePullRequestReviewStore((store) => store.editorDrafts[draftKey] ?? value);
  const setDraft = (text: string) =>
    usePullRequestReviewStore.getState().setEditorDraft(draftKey, text);
  const [preview, setPreview] = useState(false);
  const empty = draft.trim().length === 0;
  const saveDisabled = saving || (empty && !allowEmpty);

  return (
    <div
      className={cn("space-y-2", className)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!saveDisabled && !event.repeat) onSave(draft);
          return;
        }
        if (event.key !== "Escape" || saving) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <ToggleGroup
        aria-label="Markdown editor mode"
        variant="segmented"
        value={[preview ? "preview" : "write"]}
        disabled={saving}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "write" || mode === "preview") setPreview(mode === "preview");
        }}
      >
        <Toggle value="write">Write</Toggle>
        <Toggle value="preview">Preview</Toggle>
      </ToggleGroup>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground">Nothing to preview.</p>
          ) : (
            <PullRequestMarkdown
              text={draft}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
            />
          )}
        </div>
      ) : (
        <Textarea
          autoFocus
          disabled={saving}
          value={draft}
          rows={6}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="outline" disabled={saveDisabled} onClick={() => onSave(draft)}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
