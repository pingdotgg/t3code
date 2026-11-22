import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { KnowledgeSelection } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";

import {
  MAX_KNOWLEDGE_SELECTIONS,
  knowledgeSelectionKey,
  knowledgeSelectionState,
} from "../lib/projectKnowledgeComposer";
import { AppText } from "./ui/AppText";
import { Button } from "./ui/Button";

type SelectionState = ReturnType<typeof knowledgeSelectionState>;

/**
 * Draft selection, kept apart from inspection: pressing a fact or message reads it, and only this
 * control changes what the draft will reference.
 */
export function SelectForDraftControl(props: {
  readonly current: KnowledgeSelection;
  readonly state: SelectionState;
  readonly onToggle: (selection: KnowledgeSelection) => void;
  readonly onRefresh: (selection: KnowledgeSelection) => void;
}) {
  const gt = useGT();
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Button
        label={props.state === "unselected" ? gt("Select for draft") : gt("Selected for draft")}
        icon={props.state === "unselected" ? "plus" : "checkmark.circle.fill"}
        tone={props.state === "unselected" ? "secondary" : "primary"}
        onPress={() => props.onToggle(props.current)}
      />
      {props.state === "changed" ? (
        <>
          <AppText className="text-xs text-warning-foreground">
            {props.current.kind === "fact"
              ? gt("Fact changed since you selected it")
              : gt("Source changed")}
          </AppText>
          <Button
            label={gt("Use current version")}
            tone="text"
            onPress={() => props.onRefresh(props.current)}
          />
        </>
      ) : null}
    </View>
  );
}

export type DescribedSelection = {
  readonly selection: KnowledgeSelection;
  readonly label: string;
  /** The newest version this sheet has seen, or null when the item is not loaded. */
  readonly current: KnowledgeSelection | null;
};

export function ProjectKnowledgeDraftFooter(props: {
  readonly selections: ReadonlyArray<DescribedSelection>;
  readonly attachedLabel: string | null;
  readonly mismatched: boolean;
  readonly detached: boolean;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onToggle: (selection: KnowledgeSelection) => void;
  readonly onRefresh: (selection: KnowledgeSelection) => void;
  readonly onAttach: () => void;
  readonly onRemoveAttached: () => void;
}) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const changed = props.selections.filter(
    (item) => item.current && knowledgeSelectionState([item.selection], item.current) === "changed",
  ).length;
  if (props.selections.length === 0 && !props.attachedLabel && !props.mismatched && !props.detached)
    return null;
  return (
    <View
      className="gap-2 border-t border-border bg-sheet px-5 pt-3"
      style={{ paddingBottom: Math.max(12, insets.bottom) }}
    >
      {props.mismatched ? (
        <View className="gap-1">
          <AppText className="text-sm">
            <T>Attached evidence belongs to another project or environment.</T>
          </AppText>
          <Button
            label={gt("Remove mismatched reference")}
            tone="secondary"
            onPress={props.onRemoveAttached}
          />
        </View>
      ) : props.attachedLabel ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <AppText className="flex-1 text-sm">
            {gt("{label} is attached to this draft.", { label: props.attachedLabel })}
          </AppText>
          <Button label={gt("Remove from draft")} tone="text" onPress={props.onRemoveAttached} />
        </View>
      ) : props.detached ? (
        <AppText accessibilityRole="alert" className="text-sm">
          <T>
            The selection changed, so the earlier reference was removed from the draft. Attach to
            add the new selection.
          </T>
        </AppText>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-2">
        <AppText className="flex-1 text-xs text-foreground-muted">
          {gt(
            "{count} selected · up to {maximum}{changed, plural, =0 {} other { · {changed} changed since selected}}",
            {
              count: props.selections.length,
              maximum: MAX_KNOWLEDGE_SELECTIONS,
              changed,
            },
          )}
        </AppText>
        {props.selections.length > 0 ? (
          <Button
            label={expanded ? gt("Hide selection") : gt("Review selection")}
            tone="text"
            onPress={() => setExpanded((value) => !value)}
          />
        ) : null}
      </View>
      {expanded ? (
        <ScrollView
          nestedScrollEnabled
          style={{ maxHeight: 140, flexShrink: 1 }}
          contentContainerStyle={{ gap: 8 }}
          keyboardShouldPersistTaps="handled"
        >
          {props.selections.map((item) => (
            <View
              key={knowledgeSelectionKey(item.selection)}
              className="flex-row flex-wrap items-center gap-2"
            >
              <AppText className="flex-1 text-sm" numberOfLines={2}>
                {item.label}
              </AppText>
              {item.current &&
              knowledgeSelectionState([item.selection], item.current) === "changed" ? (
                <Button
                  label={gt("Use current version")}
                  tone="text"
                  onPress={() => props.onRefresh(item.current!)}
                />
              ) : null}
              <Button
                label={gt("Remove", { $context: "remove a project knowledge selection" })}
                tone="text"
                onPress={() => props.onToggle(item.selection)}
              />
            </View>
          ))}
          <AppText className="text-xs text-foreground-muted">
            <T>
              The draft keeps references and revision numbers. Current evidence is reloaded when
              sent.
            </T>
          </AppText>
        </ScrollView>
      ) : null}
      <Button
        label={gt("Attach to draft")}
        tone="primary"
        disabled={props.disabled || props.busy || props.selections.length === 0 || props.mismatched}
        loading={props.busy}
        onPress={props.onAttach}
      />
    </View>
  );
}
