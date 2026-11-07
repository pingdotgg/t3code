import { useState } from "react";
import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";

import { useT } from "~/hooks/useI18n";
export function PullRequestMarkdownEditor({
  value,
  cwd,
  environmentId,
  completionScope,
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
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly completionScope: PullRequestCompletionScope | null;
  readonly threadRef?: ScopedThreadRef | null;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly saving: boolean;
  readonly allowEmpty?: boolean;
  readonly className?: string | undefined;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const t = useT();
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  const [seed, setSeed] = useState(value);
  if (seed !== value) {
    setSeed(value);
    setDraft(value);
  }
  const empty = draft.trim().length === 0;
  const saveDisabled = !canWriteSourceControl || saving || (empty && !allowEmpty);

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
          if (
            !saveDisabled &&
            !event.repeat &&
            readEnvironmentScope(environmentId, AuthSourceControlWriteScope)
          )
            onSave(draft);
          return;
        }
        if (event.key !== "Escape" || saving) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <ToggleGroup
        aria-label={t("review.extra.markdown.editor.mode")}
        variant="segmented"
        value={[preview ? "preview" : "write"]}
        disabled={saving}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "write" || mode === "preview") setPreview(mode === "preview");
        }}
      >
        <Toggle value="write">{t("review.extra.write")}</Toggle>
        <Toggle value="preview">{t("review.extra.preview")}</Toggle>
      </ToggleGroup>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground">{t("review.extra.nothing.to.preview")}</p>
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
        <PullRequestMarkdownTextarea
          autoFocus
          disabled={saving}
          completionScope={completionScope}
          value={draft}
          rows={6}
          placeholder={placeholder}
          aria-label={label}
          onValueChange={setDraft}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
          {t("review.extra.cancel")}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!canWriteSourceControl || saving || (empty && !allowEmpty)}
          onClick={() => {
            if (
              !readEnvironmentScope(environmentId, AuthSourceControlWriteScope) ||
              saving ||
              (empty && !allowEmpty)
            )
              return;
            onSave(draft);
          }}
        >
          {saving ? t("review.extra.saving2") : t("review.extra.save")}
        </Button>
      </div>
    </div>
  );
}
