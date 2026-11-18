import { useNavigation } from "@react-navigation/native";
import {
  applyPendingPullRequestReactions,
  type PendingPullRequestReaction,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
  pullRequestReactionsSignature,
} from "@t3tools/client-runtime/pull-request-reactions";
import type {
  PullRequestComment,
  PullRequestReaction,
  PullRequestReactionContent,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, useLocale, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

const EMPTY_PENDING: ReadonlyMap<PullRequestReactionContent, PendingPullRequestReaction> =
  new Map();
const PILL = "min-h-8 flex-row items-center gap-1 rounded-full border px-2.5 active:opacity-70";

/** Reaction pills for any subject; `onReact` resolves false when the host refused the change. */
export function ReactionPills(props: {
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly canReact: boolean;
  readonly onReact: (content: PullRequestReactionContent, reacted: boolean) => Promise<boolean>;
  readonly onChanged?: () => void;
}) {
  // Keyed by what the host last reported, so a refresh that lands the change drops the overlay.
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const [pending, setPending] = useState({ signature: "", values: EMPTY_PENDING });
  const signature = pullRequestReactionsSignature(props.reactions);
  const values = pending.signature === signature ? pending.values : EMPTY_PENDING;
  const shown = applyPendingPullRequestReactions(props.reactions, values);
  const toggle = async (content: PullRequestReactionContent, reacted: boolean) => {
    const entry: PendingPullRequestReaction = { reacted };
    setPending({ signature, values: new Map([...values, [content, entry]]) });
    if (!(await props.onReact(content, reacted))) {
      setPending((current) => {
        if (current.values.get(content) !== entry) return current;
        const next = new Map(current.values);
        next.delete(content);
        return { signature: current.signature, values: next };
      });
      Dialog.alert(gt("Couldn't save the reaction"), gt("Try again in a moment."));
      return;
    }
    props.onChanged?.();
  };
  return (
    <>
      {shown.map((reaction) => (
        <Pressable
          key={reaction.content}
          accessibilityRole="button"
          accessibilityLabel={pullRequestReactionTooltip(reaction, messages, locale)}
          accessibilityState={{ selected: reaction.viewerHasReacted, disabled: !props.canReact }}
          disabled={!props.canReact}
          onPress={() => void toggle(reaction.content, !reaction.viewerHasReacted)}
          className={cn(
            PILL,
            reaction.viewerHasReacted
              ? "border-primary bg-primary/10"
              : "border-border-subtle bg-grouped-card",
          )}
        >
          <Text className="text-sm">{pullRequestReactionEmoji(reaction.content)}</Text>
          <Text className="text-xs font-t3-medium text-foreground-muted">{reaction.count}</Text>
        </Pressable>
      ))}
      {props.canReact ? (
        <Menu
          accessibilityLabel={gt("Add a reaction")}
          actions={PULL_REQUEST_REACTION_ORDER.map((content) => ({
            id: content,
            title: `${pullRequestReactionEmoji(content)}  ${pullRequestReactionName(content, messages)}`,
            state: shown.some(
              (reaction) => reaction.content === content && reaction.viewerHasReacted,
            )
              ? ("on" as const)
              : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            const content = PULL_REQUEST_REACTION_ORDER.find((id) => id === nativeEvent.event);
            if (!content) return;
            const reacted = shown.some(
              (reaction) => reaction.content === content && reaction.viewerHasReacted,
            );
            void toggle(content, !reacted);
          }}
        >
          <View className={cn(PILL, "border-border-subtle")}>
            <SymbolView name="face.smiling" size={15} tintColorClassName="accent-icon-muted" />
          </View>
        </Menu>
      ) : null}
    </>
  );
}

function usePullRequestReact(params: PullRequestParams, subjectId?: string) {
  const target = pullRequestTarget(params);
  const setReaction = useAtomCommand(composerPullRequests.setReaction, { reportFailure: false });
  return async (content: PullRequestReactionContent, reacted: boolean) =>
    !AsyncResult.isFailure(
      await setReaction({
        ...target,
        input: {
          ...target.input,
          ...(subjectId === undefined ? {} : { subjectId }),
          content,
          reacted,
        },
      }),
    );
}

/** Reactions on the change request itself, which is where its description's reactions live. */
export function PullRequestReactions(props: { readonly params: PullRequestParams }) {
  const target = pullRequestTarget(props.params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const activity = useEnvironmentQuery(composerPullRequests.activity(target));
  const { canReact } = usePullRequestPermissions(props.params, detail.data);
  const reactions = activity.data?.reactions ?? [];
  const onReact = usePullRequestReact(props.params);
  if (!activity.data || (reactions.length === 0 && !canReact)) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      <ReactionPills
        reactions={reactions}
        canReact={canReact}
        onReact={onReact}
        onChanged={activity.refresh}
      />
    </View>
  );
}

export function PullRequestCommentFooter(props: {
  readonly params: PullRequestParams;
  readonly comment: Pick<
    PullRequestComment,
    "id" | "kind" | "body" | "author" | "canEdit" | "reactions"
  >;
  readonly permissions: Pick<
    ReturnType<typeof usePullRequestPermissions>,
    "canEditComment" | "canReactComment"
  >;
  readonly onChanged: () => void;
  readonly onEdit?: () => void;
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const { comment } = props;
  const reactions = comment.reactions ?? [];
  const editableKind = comment.kind === "review" ? null : comment.kind;
  const canEdit = editableKind !== null && props.permissions.canEditComment(comment);
  const canReact = props.permissions.canReactComment(comment);
  const onReact = usePullRequestReact(props.params, comment.id);
  if (reactions.length === 0 && !canReact && !canEdit) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      <ReactionPills
        reactions={reactions}
        canReact={canReact}
        onReact={onReact}
        onChanged={props.onChanged}
      />
      {canEdit && editableKind !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Edit comment")}
          onPress={() => {
            props.onEdit?.();
            navigation.navigate("PullRequestEdit", {
              ...props.params,
              field: "comment",
              comment: {
                id: comment.id,
                kind: editableKind,
                body: comment.body,
                author: comment.author,
                ...(comment.canEdit === undefined ? {} : { canEdit: comment.canEdit }),
              },
            });
          }}
          className={cn(PILL, "ml-auto border-transparent")}
        >
          <SymbolView name="pencil" size={13} tintColorClassName="accent-icon-muted" />
          <Text className="text-xs font-t3-medium text-foreground-muted">
            <T context="verb, edit a comment">Edit</T>
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
