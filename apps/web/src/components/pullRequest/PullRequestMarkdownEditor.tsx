import { useState } from "react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { PullRequestMarkdownField } from "./PullRequestMarkdownField";

/**
 * The box a body is rewritten in — a description, or a remark already posted. It owns the draft
 * and nothing else: the caller sends the request and says whether it is still in flight, so the
 * same box serves every mutation without knowing which one it is.
 *
 * Preview renders through the same component the saved body will be read through, which is the
 * only way to see what a host's markdown will actually become before it is sent.
 */
export function PullRequestMarkdownEditor({
  value,
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
  saveLabel = "Save",
  onDraftChange,
  secondaryAction,
}: {
  readonly value: string;
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
  readonly secondaryAction?: { readonly label: string; readonly onAction: (draft: string) => void };
  readonly saveLabel?: string;
  readonly onDraftChange?: (next: string) => void;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [uploadPending, setUploadPending] = useState(false);
  const empty = draft.trim().length === 0;
  const saveDisabled = saving || uploadPending || (empty && !allowEmpty);

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
        onCancel();
      }}
    >
      <PullRequestMarkdownField
        autoFocus
        disabled={saving}
        value={draft}
        rows={6}
        placeholder={placeholder}
        aria-label={label}
        cwd={cwd}
        environmentId={environmentId}
        threadRef={threadRef}
        onUploadPendingChange={setUploadPending}
        onChange={(next) => {
          setDraft(next);
          onDraftChange?.(next);
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        {secondaryAction ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={saveDisabled}
            onClick={() => secondaryAction.onAction(draft)}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button size="xs" variant="outline" disabled={saveDisabled} onClick={() => onSave(draft)}>
          {saving ? "Saving..." : saveLabel}
        </Button>
      </div>
    </div>
  );
}
