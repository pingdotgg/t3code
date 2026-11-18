import { T, useGT } from "gt-react-native";
import { pendingCommentComposerContext, usePullRequestThreads } from "./usePullRequestThreads";
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
      <Text className="text-2xs font-t3-medium text-warning-foreground">
        <T>Pending</T>
      </Text>
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
  const gt = useGT();
  const actions = usePendingReviewCommentActions(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(params)));
  const agent = usePullRequestThreads(params, detail.data, comment.path);
  const markdown = `**Pending comment on ${comment.path}**\n\n${comment.body}`;
  return (
    <Menu
      title={gt("Comment actions")}
      actions={[
        ...(onEdit
          ? [{ id: "edit", title: gt("Edit comment"), attributes: { disabled: actions.busy } }]
          : []),
        {
          id: "copy-menu",
          title: gt("Copy", { $context: "verb, copies a comment" }),
          subactions: [
            ...(comment.hostedComment || actions.canSave
              ? [
                  {
                    id: "copy-link",
                    title: gt("Link to comment"),
                    attributes: { disabled: actions.busy },
                  },
                ]
              : []),
            { id: "copy", title: gt("Copy as Markdown") },
          ],
        },
        {
          id: "composer",
          title: gt("Add to composer"),
          attributes: { disabled: !agent.canAsk || agent.busy },
        },
        ...(!comment.hostedComment || actions.canDiscard
          ? [
              {
                id: "discard",
                title: gt("Discard comment"),
                attributes: { destructive: true, disabled: actions.busy },
              },
            ]
          : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "edit") onEdit?.();
        else if (nativeEvent.event === "copy") void Clipboard.setStringAsync(markdown);
        else if (nativeEvent.event === "composer") {
          if (agent.canAddToComposer && detail.data)
            void agent.addToComposer({
              context: pendingCommentComposerContext(detail.data, comment),
              filePath: comment.path,
            });
          else
            void agent.ask(
              agent.threads.length === 1 ? agent.threads[0] : undefined,
              "ask",
              markdown,
            );
        } else if (nativeEvent.event === "copy-link") void actions.copyLink(comment);
        else if (nativeEvent.event === "discard")
          Alert.alert(gt("Discard this comment?"), gt("Your other review comments will be kept."), [
            { text: gt("Cancel"), style: "cancel" },
            {
              text: gt("Discard"),
              style: "destructive",
              onPress: () => void actions.discard(comment),
            },
          ]);
      }}
    >
      <ControlPill
        icon="ellipsis"
        accessibilityLabel={gt("Comment actions")}
        disabled={actions.busy}
      />
    </Menu>
  );
}
