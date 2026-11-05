import { toolCallDiff } from "@t3tools/client-runtime/work-log/file-change-diff";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { Text, View } from "react-native";

import { patchLines, type PatchLineKind } from "../../lib/patchLines";

// Nested Text spans stay cheap to lay out; a full stored diff (32 KB) can reach a thousand lines.
const MAX_DIFF_LINES = 400;

const LINE_CLASS: Record<PatchLineKind, string> = {
  header: "text-foreground-subtle",
  hunk: "text-foreground-subtle",
  addition: "text-adaptive-emerald-600-400",
  deletion: "text-adaptive-rose-600-400",
  context: "text-foreground-muted",
};

const monoClassName = "font-mono text-2xs leading-normal";

export function FileChangeDiffText(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "file_change" }>;
}) {
  const diff = toolCallDiff(props.item);
  const shown = diff.patch?.trim() ? patchLines(diff.patch, MAX_DIFF_LINES) : null;
  if (shown === null && diff.content.length === 0) {
    return (
      <Text className={`mt-1.5 ${monoClassName} italic text-foreground-subtle`}>
        No diff recorded.
      </Text>
    );
  }
  const notes = [
    shown && shown.hiddenCount > 0 ? `${shown.hiddenCount} more lines not shown.` : null,
    diff.truncated ? "The recorded change was truncated." : null,
  ].filter((note) => note !== null);
  return (
    <View className="mt-1.5 gap-1.5">
      {shown ? (
        <Text selectable className={monoClassName}>
          {shown.lines.map((line, index) => (
            /* oxlint-disable-next-line react/no-array-index-key -- Diff lines are stateless positions. */
            <Text key={index} className={LINE_CLASS[line.kind]}>
              {index > 0 ? "\n" : ""}
              {line.text}
            </Text>
          ))}
        </Text>
      ) : (
        diff.content.map(({ label, text }) => (
          <View key={label}>
            <Text className={`${monoClassName} text-foreground-subtle`}>{label}</Text>
            <Text selectable className={`${monoClassName} text-foreground-muted`}>
              {text === "" ? "Empty content." : text}
            </Text>
          </View>
        ))
      )}
      {notes.map((note) => (
        <Text key={note} className={`${monoClassName} italic text-foreground-subtle`}>
          {note}
        </Text>
      ))}
    </View>
  );
}
