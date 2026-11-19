import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import {
  pullRequestListLines,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  type PullRequestListLine,
} from "@t3tools/client-runtime/thread-pull-requests";
import { useGT, useMessages } from "gt-react-native";
import { memo, useMemo } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { RelativeTime } from "../../components/RelativeTime";
import type { EnvironmentRuntimeState } from "../../state/remote-runtime-types";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import type { LinkedPullRequestActions } from "./useLinkedPullRequestActions";
import { pullRequestListReviewStatus } from "../pull-requests/pullRequestList";
import {
  PullRequestAvatar,
  PullRequestConflictBadge,
  PullRequestDiffStats,
} from "../pull-requests/PullRequestPresentation";
import {
  pullRequestChecksStatus,
  pullRequestConflict,
  pullRequestStatus,
} from "../pull-requests/pullRequestStatus";

export function useLinkedPullRequestLines(
  thread: EnvironmentThreadShell | null,
  runtime: EnvironmentRuntimeState | null,
) {
  const supported = (runtime?.serverConfig ?? null) !== null;
  const pullRequests = thread?.pullRequests;
  return useMemo(() => {
    const chains = resolveThreadPullRequestChains(supported ? (pullRequests ?? []) : []);
    const open = chains.filter((chain) => chain.layers.some(isOpenLink));
    const done = chains.filter((chain) => !chain.layers.some(isOpenLink));
    return [...pullRequestListLines(open), ...pullRequestListLines(done)];
  }, [pullRequests, supported]);
}

function isOpenLink(link: PullRequestListLine["link"]) {
  return link.snapshot === null || link.snapshot.state === "open";
}

export function linkedPullRequestKey(line: PullRequestListLine) {
  return threadPullRequestKeyOf(line.link);
}

export const LinkedPullRequestRow = memo(function LinkedPullRequestRow(props: {
  readonly line: PullRequestListLine;
  readonly separator: boolean;
  readonly surfaceClassName: string;
  readonly openPullRequest: (url: string) => Promise<boolean>;
  readonly actions: LinkedPullRequestActions | null;
  /** Settled and archived threads keep their links but stop watching them. */
  readonly watchesSuspended?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { link, depth, stack } = props.line;
  const snapshot = link.snapshot;
  const status = snapshot === null ? null : pullRequestStatus(snapshot, messages);
  const conflict = snapshot === null ? null : pullRequestConflict(snapshot, messages);
  const open = snapshot === null || snapshot.state === "open";
  const checks =
    open && snapshot?.checksState ? pullRequestChecksStatus(snapshot.checksState) : null;
  const review =
    open && snapshot?.reviewDecision
      ? pullRequestListReviewStatus(
          {
            reviewDecision: snapshot.reviewDecision,
            viewerReviewRequested: false,
          },
          messages,
        )
      : null;
  const watching = open && link.watch !== undefined;
  const watchPaused = watching && props.watchesSuspended === true;
  const additions = snapshot?.additions ?? 0;
  const deletions = snapshot?.deletions ?? 0;
  const term = changeRequestTermKind(
    (sourceControlClients.findByChangeRequestUrl(link.url) ?? sourceControlClients.get(undefined))
      .changeRequest,
  );
  const metaLineHeight = useScaledTextRole("label").lineHeight * useWindowDimensions().fontScale;
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        gt(
          "{term, select, mr {Merge request {number}, {title}} cr {Change request {number}, {title}} other {Pull request {number}, {title}}}",
          {
            term,
            number: link.number,
            title: snapshot?.title ?? gt("waiting for host state"),
          },
        ),
        status?.label,
        conflict === null || snapshot === null
          ? undefined
          : snapshot.baseBranch
            ? gt("conflicts with {branch}", { branch: snapshot.baseBranch })
            : gt("has conflicts"),
        link.repository,
        stack
          ? gt("{size, plural, one {stack of {size}} other {stack of {size}}}", {
              size: stack.size,
            })
          : undefined,
        watching ? gt("watching") : undefined,
        checks === null
          ? undefined
          : snapshot?.checksState === "passing"
            ? gt("checks passing")
            : snapshot?.checksState === "failing"
              ? gt("checks failing")
              : gt("checks pending"),
        review?.accessibleLabel,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={props.actions ? gt("Touch and hold for actions.") : undefined}
      onPress={() => {
        void props.openPullRequest(link.url).then((opened) => {
          if (!opened)
            Dialog.alert(
              gt(
                "{term, select, mr {Unable to open MR} cr {Unable to open change request} other {Unable to open PR}}",
                { term },
              ),
              gt(
                "{term, select, mr {The merge request could not be opened.} cr {The change request could not be opened.} other {The pull request could not be opened.}}",
                { term },
              ),
            );
        });
      }}
      style={{ paddingLeft: 16 + Math.min(depth, 3) * 16 }}
      className="flex-row gap-3 rounded-xl pr-4 active:bg-row-hover"
    >
      {depth > 0 ? <View className="-ml-2 w-px self-stretch bg-border" /> : null}
      <View className="self-start pt-2.5">
        <SymbolView
          name={status?.icon ?? PullRequestGlyph.pullRequest}
          size={20}
          tintColorClassName={status?.tint ?? "accent-icon-muted"}
        />
        {conflict ? <PullRequestConflictBadge surfaceClassName={props.surfaceClassName} /> : null}
      </View>
      <View
        className={cn(
          "min-w-0 flex-1 gap-1 py-2.5",
          props.separator && "border-b border-border-subtle",
        )}
      >
        <View className="flex-row items-center gap-1.5">
          {snapshot?.author ? <PullRequestAvatar actor={snapshot.author} size={16} /> : null}
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {link.repository}
          </Text>
          <Text className="shrink-0 text-xs text-foreground-tertiary">#{link.number}</Text>
          <View className="flex-1" />
          {stack ? (
            <View className="flex-row items-center gap-1">
              <SymbolView
                name={PullRequestGlyph.stack}
                size={12}
                tintColorClassName="accent-foreground-muted"
              />
              <Text className="text-2xs tabular-nums text-foreground-muted">{stack.size}</Text>
            </View>
          ) : null}
          {watching ? (
            <SymbolView
              name={watchPaused ? "eye.slash" : "eye"}
              size={13}
              tintColorClassName="accent-foreground-muted"
            />
          ) : null}
          {checks ? (
            <SymbolView name={checks.icon} size={13} tintColorClassName={checks.tint} />
          ) : null}
          {review ? (
            <SymbolView name={review.icon} size={13} tintColorClassName={review.tint} />
          ) : null}
          {additions + deletions > 0 || snapshot?.updatedAt ? (
            <View
              className="-ml-1.5 flex-row flex-wrap items-center gap-x-1.5 overflow-hidden"
              style={{ height: metaLineHeight, flexShrink: 100 }}
            >
              <View className="w-0" />
              {additions + deletions > 0 ? (
                <PullRequestDiffStats additions={additions} deletions={deletions} compact />
              ) : null}
              {snapshot?.updatedAt ? (
                <Text className="text-2xs tabular-nums text-foreground-tertiary">
                  <RelativeTime timestamp={snapshot.updatedAt} />
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
        <Text
          className="text-base leading-5 font-t3-medium text-foreground"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {snapshot?.title ?? gt("Waiting for host state")}
        </Text>
      </View>
    </Pressable>
  );
  const actions = props.actions;
  if (actions === null) return row;
  return (
    <Menu
      shouldOpenOnLongPress
      title={`#${link.number} · ${link.repository}`}
      actions={actions.menuActions(link)}
      onPressAction={({ nativeEvent }) => actions.onMenuAction(link, nativeEvent.event)}
    >
      {row}
    </Menu>
  );
});
