import type { LinearIssue } from "@t3tools/contracts";
import { blockedByTitle, isLinearIssueBlocked } from "@t3tools/shared/linearBlocked";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

/** Shown only while an open blocker remains; the accessibility label names the blockers. */
export function LinearBlockedBadge(props: {
  readonly issue: Pick<LinearIssue, "blockedBy" | "state">;
}) {
  if (!isLinearIssueBlocked(props.issue)) return null;
  return (
    <View
      accessibilityLabel={blockedByTitle(props.issue)}
      className="flex-row items-center gap-0.5"
    >
      <SymbolView name="exclamationmark.circle" size={11} tintColorClassName="accent-icon-muted" />
      <Text className="text-2xs font-t3-medium text-warning-foreground">Blocked</Text>
    </View>
  );
}
