import { usePullRequestThreads } from "./usePullRequestThreads";
import { canEditPullRequestComment } from "@t3tools/client-runtime/review-editing";
import { PullRequestCommentComposer } from "./PullRequestCommentComposer";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAtomValue } from "@effect/atom-react";
import {
  PULL_REQUEST_REACTION_ORDER,
  applyPendingPullRequestReactions,
  pullRequestReactionEmoji,
  pullRequestReactionName,
} from "@t3tools/client-runtime/review-reactions";
import type {
  PullRequestActor,
  PullRequestReaction,
  PullRequestReactionContent,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Alert, Linking, Modal, Pressable, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { ControlPill } from "../../components/ui/ControlPill";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

/** Native controls share reaction vocabulary and optimistic counts with desktop. */
export function PullRequestCommentControls({
  params,
  comment,
  onEdit,
  onUnresolve,
  onResolve,
  disabled,
  render,
}: {
  params: PullRequestParams;
  comment: {
    id: string;
    body: string;
    url: string | null;
    reactions?: ReadonlyArray<PullRequestReaction> | undefined;
    kind?: string;
    author?: PullRequestActor | null;
    canEdit?: boolean;
  };
  onEdit?: (() => void) | undefined;
  onUnresolve?: (() => void) | undefined;
  onResolve?: (() => void) | undefined;
  disabled?: boolean;
  render?: (slots: { actions: ReactNode; reactions: ReactNode }) => ReactNode;
}) {
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const activity = useEnvironmentQuery(composerPullRequests.activity(target));
  const agent = usePullRequestThreads(params, detail.data);
  const markdown = `${comment.author?.login ? `**${comment.author.login}**\n\n` : ""}${comment.body}${comment.url ? `\n\n[View comment](${comment.url})` : ""}`;
  const allowed = useAtomValue(
    composerPullRequests.setReaction.permissionAtom(target.environmentId),
  );
  const write = useAtomCommand(composerPullRequests.setReaction, { reportFailure: false });
  const update = useAtomCommand(composerPullRequests.updateComment, { reportFailure: false });
  const canWriteComment = useAtomValue(
    composerPullRequests.updateComment.permissionAtom(target.environmentId),
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const kind =
    comment.kind === undefined
      ? "review-comment"
      : comment.kind === "issue-comment"
        ? "issue-comment"
        : comment.kind === "review-comment"
          ? "review-comment"
          : "review";
  const canEdit =
    canWriteComment &&
    detail.data !== null &&
    canEditPullRequestComment(detail.data, {
      kind,
      author: comment.author ?? null,
      ...(comment.canEdit === undefined ? {} : { canEdit: comment.canEdit }),
    });
  const edit = () => {
    if (onEdit) onEdit();
    else {
      setDraft(comment.body);
      setEditing(true);
    }
  };
  const save = async () => {
    if (!canEdit || saving || uploading || !draft.trim() || kind === "review") return;
    setSaving(true);
    const result = await update({
      ...target,
      input: { ...target.input, commentId: comment.id, kind, body: draft },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      Alert.alert("Could not edit the comment", "Your draft has been kept. Try again.");
      return;
    }
    setEditing(false);
    activity.refresh();
  };
  const reactions = comment.reactions ?? [];
  const signature = JSON.stringify(reactions);
  const [state, setState] = useState({
    signature,
    overlay: new Map<PullRequestReactionContent, boolean>(),
  });
  const [busy, setBusy] = useState(false);
  if (signature !== state.signature) setState({ signature, overlay: new Map() });
  const shown = applyPendingPullRequestReactions(
    reactions,
    state.signature === signature ? state.overlay : new Map(),
  );
  const canReact = allowed && detail.data?.capabilities.reactions === true;
  const react = async (content: PullRequestReactionContent) => {
    if (!canReact || busy) return;
    const reacted = !shown.find((reaction) => reaction.content === content)?.viewerHasReacted;
    setState((current) => ({ signature, overlay: new Map(current.overlay).set(content, reacted) }));
    setBusy(true);
    const result = await write({
      ...target,
      input: { ...target.input, subjectId: comment.id, content, reacted },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setState({ signature, overlay: new Map() });
      Alert.alert("Could not save the reaction");
    } else activity.refresh();
  };
  const reactionChips = shown.map((reaction) => (
    <Pressable
      key={reaction.content}
      disabled={!canReact || busy}
      accessibilityRole="button"
      accessibilityState={{ selected: reaction.viewerHasReacted }}
      accessibilityLabel={`${pullRequestReactionName(reaction.content)}, ${reaction.count}`}
      className="min-h-9 min-w-11 items-center justify-center rounded-full border border-border-subtle px-2"
      onPress={() => void react(reaction.content)}
    >
      <Text className="text-xs">
        {pullRequestReactionEmoji(reaction.content)} {reaction.count}
      </Text>
    </Pressable>
  ));
  const reactionPicker = canReact ? (
    <Menu
      title="Add reaction"
      actions={PULL_REQUEST_REACTION_ORDER.map((content) => ({
        id: content,
        title: `${pullRequestReactionEmoji(content)} ${pullRequestReactionName(content)}`,
        state: shown.some((reaction) => reaction.content === content && reaction.viewerHasReacted)
          ? ("on" as const)
          : ("off" as const),
        attributes: { disabled: busy || Boolean(disabled) },
      }))}
      onPressAction={({ nativeEvent }) => {
        const content = PULL_REQUEST_REACTION_ORDER.find(
          (content) => content === nativeEvent.event,
        );
        if (content) void react(content);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add reaction"
        disabled={busy || disabled}
        className="min-h-11 min-w-11 items-center justify-center"
      >
        <SymbolView name="face.smiling" size={18} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </Menu>
  ) : null;
  const commentMenu = (
    <Menu
      title="Comment actions"
      actions={[
        ...(onResolve
          ? [
              {
                id: "resolve",
                title: "Resolve thread",
                attributes: { disabled: Boolean(disabled) },
              },
            ]
          : []),
        ...(onUnresolve
          ? [
              {
                id: "unresolve",
                title: "Unresolve thread",
                attributes: { disabled: Boolean(disabled) },
              },
            ]
          : []),
        ...(onEdit || canEdit ? [{ id: "edit", title: "Edit comment" }] : []),
        {
          id: "copy-menu",
          title: "Copy",
          subactions: [
            ...(comment.url ? [{ id: "copy-link", title: "Link to comment" }] : []),
            { id: "copy", title: "Copy as Markdown" },
          ],
        },
        {
          id: "composer",
          title: "Add to composer",
          attributes: { disabled: !agent.canAsk || agent.busy },
        },
        ...(comment.url
          ? [
              {
                id: "open",
                title: detail.data?.provider === "github" ? "Open in GitHub" : "Open on host",
              },
            ]
          : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "resolve") onResolve?.();
        else if (nativeEvent.event === "composer")
          void agent.ask(
            agent.threads.length === 1 ? agent.threads[0] : undefined,
            "ask",
            markdown,
          );
        else if (nativeEvent.event === "unresolve") onUnresolve?.();
        else if (nativeEvent.event === "edit") edit();
        else if (nativeEvent.event === "copy") void Clipboard.setStringAsync(markdown);
        else if (nativeEvent.event === "copy-link" && comment.url)
          void Clipboard.setStringAsync(comment.url);
        else if (nativeEvent.event === "open" && comment.url) void Linking.openURL(comment.url);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Comment actions"
        className="min-h-11 min-w-11 items-center justify-center"
      >
        <SymbolView name="ellipsis" size={16} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </Menu>
  );
  const actions = (
    <View className="flex-row items-center">
      {reactionPicker}
      {commentMenu}
    </View>
  );
  return (
    <>
      {render ? (
        render({
          actions,
          reactions: shown.length ? (
            <View className="flex-row flex-wrap items-center gap-1">{reactionChips}</View>
          ) : null,
        })
      ) : (
        <View className="flex-row flex-wrap items-center gap-1">
          {reactionChips}
          {actions}
        </View>
      )}
      <Modal
        visible={editing}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!saving && !uploading) setEditing(false);
        }}
      >
        <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1 justify-end">
          <Pressable
            className="absolute inset-0 bg-black/40"
            accessibilityLabel="Close comment editor"
            onPress={() => {
              if (!saving && !uploading) setEditing(false);
            }}
          />
          <SafeAreaView
            edges={["bottom"]}
            className="gap-3 rounded-t-[24px] bg-sheet px-4 pt-3 pb-4"
          >
            <View className="flex-row items-center gap-2">
              <Text className="min-w-0 flex-1 text-base font-t3-semibold">Edit comment</Text>
              <ControlPill
                icon="xmark"
                accessibilityLabel="Cancel editing"
                disabled={saving || uploading}
                onPress={() => setEditing(false)}
              />
            </View>
            <PullRequestCommentComposer
              params={params}
              label="Edit comment body"
              placeholder="Edit your comment…"
              value={draft}
              onChangeText={setDraft}
              editable={!saving && canEdit}
              busy={saving}
              canSubmit={canEdit && !saving && !uploading && Boolean(draft.trim())}
              submitLabel={saving ? "Saving…" : "Save"}
              showSubmitLabel
              onSubmit={() => void save()}
              onBusyChange={setUploading}
              autoFocus
            />
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}
