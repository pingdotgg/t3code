import { usePullRequestThreads } from "./usePullRequestThreads";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestTarget } from "./usePullRequestDiff";
import * as Clipboard from "expo-clipboard";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { ControlPill } from "../../components/ui/ControlPill";
import type { PendingReviewComment } from "./pullRequestReviewDrafts";
import type { PullRequestParams } from "./usePullRequestDiff";
import { usePendingReviewCommentActions } from "./usePendingReviewCommentActions";

export function PullRequestPendingBadge() {
  return (
    <View className="flex-row items-center gap-1 rounded-md bg-warning px-2 py-1">
      <SymbolView name="clock" size={12} tintColorClassName="accent-warning-foreground" />
      <Text className="text-2xs font-t3-medium text-warning-foreground">Pending</Text>
    </View>
  );
}

export function PullRequestPendingCommentActions({
  params,
  comment,
  onEdit,
}: {
  params: PullRequestParams;
  comment: PendingReviewComment;
  onEdit?: () => void;
}) {
  const actions = usePendingReviewCommentActions(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(params)));
  const agent = usePullRequestThreads(params, detail.data, comment.path);
  const markdown = `**Pending comment on ${comment.path}**\n\n${comment.body}`;
  return (
    <Menu
      title="Comment actions"
      actions={[
        ...(onEdit
          ? [{ id: "edit", title: "Edit comment", attributes: { disabled: actions.busy } }]
          : []),
        {
          id: "copy-menu",
          title: "Copy",
          subactions: [
            ...(comment.hostedComment || actions.canSave
              ? [
                  {
                    id: "copy-link",
                    title: "Link to comment",
                    attributes: { disabled: actions.busy },
                  },
                ]
              : []),
            { id: "copy", title: "Copy as Markdown" },
          ],
        },
        {
          id: "composer",
          title: "Add to composer",
          attributes: { disabled: !agent.canAsk || agent.busy },
        },
        ...(!comment.hostedComment || actions.canDiscard
          ? [
              {
                id: "discard",
                title: "Discard comment",
                attributes: { destructive: true, disabled: actions.busy },
              },
            ]
          : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "edit") onEdit?.();
        else if (nativeEvent.event === "copy") void Clipboard.setStringAsync(markdown);
        else if (nativeEvent.event === "composer")
          void agent.ask(
            agent.threads.length === 1 ? agent.threads[0] : undefined,
            "ask",
            markdown,
          );
        else if (nativeEvent.event === "copy-link") void actions.copyLink(comment);
        else if (nativeEvent.event === "discard")
          Alert.alert("Discard this comment?", "Your other review comments will be kept.", [
            { text: "Cancel", style: "cancel" },
            { text: "Discard", style: "destructive", onPress: () => void actions.discard(comment) },
          ]);
      }}
    >
      <ControlPill icon="ellipsis" accessibilityLabel="Comment actions" disabled={actions.busy} />
    </Menu>
  );
}
