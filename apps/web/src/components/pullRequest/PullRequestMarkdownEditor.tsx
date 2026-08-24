import { useState } from "react";

import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

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
  placeholder,
  label,
  saving,
  allowEmpty = false,
  className,
  onSave,
  onCancel,
}: {
  readonly value: string;
  readonly cwd: string;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly saving: boolean;
  /** A description may be cleared, which is how one is removed; a remark may not be emptied. */
  readonly allowEmpty?: boolean;
  readonly className?: string | undefined;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  // The words this draft started from. React keeps a component instance wherever the same
  // position and key come round again, so an editor opened on one remark can be handed another's
  // words without being rebuilt — and saving would then write the first remark's text onto the
  // second. Different words mean a different subject, and the draft starts again from them.
  const [seed, setSeed] = useState(value);
  if (seed !== value) {
    setSeed(value);
    setDraft(value);
  }
  const empty = draft.trim().length === 0;

  return (
    <div
      className={cn("space-y-2", className)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || saving) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="flex items-center gap-1">
        <Button
          size="xs"
          variant={preview ? "ghost" : "outline"}
          disabled={saving}
          onClick={() => setPreview(false)}
        >
          {t("pullRequest.editor.write")}
        </Button>
        <Button
          size="xs"
          variant={preview ? "outline" : "ghost"}
          disabled={saving}
          onClick={() => setPreview(true)}
        >
          {t("pullRequest.editor.preview")}
        </Button>
      </div>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground">{t("pullRequest.editor.emptyPreview")}</p>
          ) : (
            <PullRequestMarkdown text={draft} cwd={cwd} />
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
          {t("common.cancel")}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={saving || (empty && !allowEmpty)}
          onClick={() => onSave(draft)}
        >
          {saving ? t("pullRequest.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
