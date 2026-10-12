import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconGitMerge from "@tabler/icons-react-native/IconGitMerge";
import IconGitCommit from "@tabler/icons-react-native/IconGitCommit";
import IconGitPullRequestClosed from "@tabler/icons-react-native/IconGitPullRequestClosed";
import IconGitPullRequestDraft from "@tabler/icons-react-native/IconGitPullRequestDraft";
import type { SFSymbol } from "expo-symbols";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import IconFileDiff from "@tabler/icons-react-native/IconFileDiff";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import type { AppSymbolViewProps } from "./AppSymbol";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName } from "./AppSymbol";

const CUSTOM_ICONS = {
  "file.diff": IconFileDiff,
  "arrow.triangle.pull": IconGitPullRequest,
  "arrow.triangle.merge": IconGitMerge,
  "arrow.triangle.branch": IconGitBranch,
  "arrow.branch": IconGitBranch,
  "git.pull-request.closed": IconGitPullRequestClosed,
  "git.pull-request.draft": IconGitPullRequestDraft,
  "git.commit": IconGitCommit,
};

function AppSymbolView(props: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  const CustomIcon = CUSTOM_ICONS[name as keyof typeof CUSTOM_ICONS];
  if (CustomIcon) {
    return (
      <CustomIcon
        accessibilityLabel={props.accessibilityLabel}
        color={props.tintColor}
        size={props.size}
        strokeWidth={2}
        style={props.style}
        testID={props.testID}
      />
    );
  }

  return <ExpoSymbolView {...props} name={name as SFSymbol} />;
}

export const SymbolView = withUniwind(AppSymbolView);
