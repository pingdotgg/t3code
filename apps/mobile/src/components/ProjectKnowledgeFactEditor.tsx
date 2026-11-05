import { useEffect, useState } from "react";
import { View } from "react-native";
import type { KnowledgeFactSource, ProjectFact } from "@t3tools/contracts";

import { AppText, AppTextInput } from "./ui/AppText";
import { Button } from "./ui/Button";

type ActiveProjectFact = Exclude<ProjectFact, { readonly status: "forgotten" }>;
export type FactEditorMode =
  | {
      readonly kind: "create";
      readonly content: string;
      readonly sources: ReadonlyArray<KnowledgeFactSource>;
      readonly note?: string;
    }
  | { readonly kind: "edit" | "supersede"; readonly fact: ActiveProjectFact };
export type FactEditorFields = {
  readonly content: string;
  readonly entities: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly kind: ProjectFact["kind"];
};

const FACT_KINDS = ["decision", "constraint", "convention", "note"] as const;

const parseLabels = (value: string) =>
  [
    ...new Set(
      value
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ].slice(0, 32);

export const factEditorTitle = (mode: FactEditorMode) =>
  mode.kind === "edit" ? "Edit fact" : mode.kind === "supersede" ? "Replace fact" : "New fact";

/** Explicit edit mode: the inspector never edits in place, and Cancel discards these fields. */
export function ProjectKnowledgeFactEditor(props: {
  readonly mode: FactEditorMode;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onSave: (fields: FactEditorFields) => void;
  readonly onCancel: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const { mode } = props;
  const base = mode.kind === "create" ? null : mode.fact;
  const [content, setContent] = useState(mode.kind === "create" ? mode.content : mode.fact.content);
  const [entities, setEntities] = useState(base?.entities.join(", ") ?? "");
  const [tags, setTags] = useState(base?.tags.join(", ") ?? "");
  const [kind, setKind] = useState<ProjectFact["kind"]>(base?.kind ?? "note");
  const dirty =
    content !== (mode.kind === "create" ? mode.content : mode.fact.content) ||
    (mode.kind === "create" && content.trim().length > 0) ||
    entities !== (base?.entities.join(", ") ?? "") ||
    tags !== (base?.tags.join(", ") ?? "") ||
    kind !== (base?.kind ?? "note");
  const { onDirtyChange } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the parent's leave guard in step, including pre-filled drafts, and releases it on unmount
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  return (
    <View className="gap-3">
      {mode.kind === "create" && mode.sources.some((ref) => ref.kind === "message") ? (
        <AppText className="text-xs text-foreground-muted">Cites the selected message.</AppText>
      ) : null}
      {mode.kind === "create" && mode.note ? (
        <AppText className="text-xs text-foreground-muted">{mode.note}</AppText>
      ) : null}
      {mode.kind === "supersede" ? (
        <AppText className="text-xs text-foreground-muted">
          Saves a new fact and marks the current one as superseded. The old text stays in its
          history.
        </AppText>
      ) : null}
      <AppTextInput
        accessibilityLabel="Fact content"
        value={content}
        onChangeText={setContent}
        placeholder="A durable project fact"
        multiline
        autoFocus
        maxLength={12_000}
        textAlignVertical="top"
        style={{ minHeight: 120 }}
      />
      <AppTextInput
        accessibilityLabel="Entities"
        value={entities}
        onChangeText={setEntities}
        placeholder="Entities, comma separated"
        maxLength={2_048}
      />
      <AppTextInput
        accessibilityLabel="Tags"
        value={tags}
        onChangeText={setTags}
        placeholder="Tags, comma separated"
        maxLength={2_048}
      />
      <View className="flex-row flex-wrap gap-2">
        {FACT_KINDS.map((value) => (
          <Button
            key={value}
            label={value}
            tone={kind === value ? "primary" : "secondary"}
            onPress={() => setKind(value)}
          />
        ))}
      </View>
      <Button
        label="Save"
        tone="primary"
        disabled={!props.canMutate || props.busy || !content.trim()}
        loading={props.busy}
        onPress={() =>
          props.onSave({
            content: content.trim(),
            entities: parseLabels(entities),
            tags: parseLabels(tags),
            kind,
          })
        }
      />
      <Button label="Cancel" tone="text" disabled={props.busy} onPress={props.onCancel} />
    </View>
  );
}
