import { DEFAULT_VCS_TERMINOLOGY, type VcsTerminology } from "@t3tools/shared/vcs";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../../lib/changeRequestTerm";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { msg } from "gt-react-native";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { Button } from "../../../components/ui/Button";
import type { MessageResolver } from "../../../i18n/messages";

export function SheetActionButton(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly onPress: () => void;
}) {
  return (
    <View className="flex-1">
      <Button {...props} fullWidth />
    </View>
  );
}

export function menuItemIconName(
  icon: "commit" | "push" | "pr",
): ComponentProps<typeof SymbolView>["name"] {
  if (icon === "commit") return "checkmark.circle";
  if (icon === "push") return "arrow.up.circle";
  return "arrow.up.right.circle";
}

export function statusSummary(
  gitStatus: {
    readonly isRepo?: boolean;
    readonly hasWorkingTreeChanges?: boolean;
    readonly workingTree?: { readonly files: readonly { readonly path: string }[] };
    readonly aheadCount?: number;
    readonly behindCount?: number;
    readonly pr?: { readonly state?: string; readonly number?: number } | null;
    readonly sourceControlProvider?: { readonly kind: string } | null;
  } | null,
  resolve: MessageResolver,
  terminology: VcsTerminology = DEFAULT_VCS_TERMINOLOGY,
): string {
  if (!gitStatus) {
    return terminology.systemName === "Git"
      ? resolve(msg("Loading branch status\u2026"))
      : resolve(msg("Loading {refNoun} status…", { refNoun: terminology.refNoun }));
  }

  if (!gitStatus.isRepo) {
    return terminology.systemName === "Git"
      ? resolve(msg("Not a git repository"))
      : resolve(msg("Not a {systemName} repository", { systemName: terminology.systemName }));
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    const fileCount = gitStatus.workingTree?.files.length ?? 0;
    parts.push(
      resolve(
        msg("{count, plural, one {{count} file changed} other {{count} files changed}}", {
          count: fileCount,
        }),
      ),
    );
  } else {
    parts.push(resolve(msg("Clean", { $context: "git working tree has no changes" })));
  }
  if ((gitStatus.aheadCount ?? 0) > 0) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} ahead} other {{count} ahead}}", {
          count: gitStatus.aheadCount,
        }),
      ),
    );
  }
  if ((gitStatus.behindCount ?? 0) > 0) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} behind} other {{count} behind}}", {
          count: gitStatus.behindCount,
        }),
      ),
    );
  }
  if (gitStatus.pr?.state === "open") {
    const term = changeRequestTermKind(
      sourceControlClients.get(gitStatus.sourceControlProvider?.kind).changeRequest,
    );
    parts.push(
      resolve(
        msg(
          "{term, select, mr {MR #{number} open} cr {change request #{number} open} other {PR #{number} open}}",
          { term, number: gitStatus.pr.number },
        ),
      ),
    );
  }

  return parts.join(" \u00b7 ");
}
