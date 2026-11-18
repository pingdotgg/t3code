import { parsePullRequestAnchor } from "@t3tools/shared/pullRequestAnchor";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { PullRequestAction, PullRequestDetail } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import Animated from "react-native-reanimated";
import { PR_ROW_LAYOUT, PR_DISCLOSURE_ENTER, PR_ROW_EXIT } from "./pullRequestAnimations";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { PullRequestCardRow } from "./PullRequestControls";
import { PullRequestAgentRow } from "./PullRequestAgentRow";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import {
  allowedUpdateMethods,
  PR_ACTION_ICONS,
  pullRequestActionLabel,
} from "./pullRequestActions";
import {
  checkStatus,
  isFailingCheck,
  pullRequestBranchSummary,
  pullRequestChecksSummary,
  pullRequestReviewSummary,
  pullRequestStatus,
} from "./pullRequestStatus";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestAction } from "./usePullRequestAction";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";

type RowProps = { readonly pr: PullRequestDetail; readonly params: PullRequestParams };
const STATUS_ACTIONS: readonly PullRequestAction[] = [
  "ready",
  "draft",
  "close",
  "reopen",
  "revert",
];
const CHECK_PRIORITY = {
  failure: 0,
  "action-required": 1,
  pending: 2,
  cancelled: 3,
  neutral: 4,
  skipped: 5,
  success: 6,
};

export function PullRequestStatusMenu(props: RowProps) {
  const action = usePullRequestAction(props.params, props.pr);
  const actions = STATUS_ACTIONS.filter(action.available);
  const gt = useGT();
  const m = useMessages();
  const status = pullRequestStatus(props.pr, m);
  const terminology = sourceControlClients.get(props.pr.provider).changeRequest;
  const term = changeRequestTermKind(terminology);
  const trigger = (
    <Pressable
      accessibilityRole={actions.length ? "button" : undefined}
      accessibilityLabel={gt(
        "{term, select, mr {Merge request} cr {Change request} other {Pull request}} status, {status}",
        { term, status: status.label },
      )}
      disabled={!actions.length}
      className="min-h-8 flex-row items-center gap-1.5 active:opacity-70"
    >
      <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
      <Text className={`text-xs font-t3-medium ${status.text}`}>{status.label}</Text>
      {actions.length ? (
        <SymbolView name="chevron.down" size={9} tintColorClassName="accent-icon-muted" />
      ) : null}
    </Pressable>
  );
  if (!actions.length) return trigger;
  return (
    <Menu
      title={gt(
        "{term, select, mr {Merge request} cr {Change request} other {Pull request}} status",
        { term },
      )}
      actions={actions.map((id) => ({
        id,
        title: pullRequestActionLabel(id, terminology, m),
        image: PR_ACTION_ICONS[id],
        attributes: { destructive: id === "close" },
      }))}
      onPressAction={({ nativeEvent }) => {
        const selected = actions.find((id) => id === nativeEvent.event);
        if (!selected) return;
        if (selected === "close") action.confirmClose();
        else if (selected === "revert")
          action.confirm(
            selected,
            pullRequestActionLabel("revert", terminology, m),
            gt(
              "Open a new {term, select, mr {merge request} cr {change request} other {pull request}} that reverses these changes?",
              { term },
            ),
          );
        else void action.perform(selected);
      }}
    >
      {trigger}
    </Menu>
  );
}

export function PullRequestChecksRow(props: RowProps) {
  const linked = parsePullRequestAnchor(props.params.navigationUrl)?.kind === "checks";
  const [expanded, setExpanded] = useState(linked);
  const [seenNavigation, setSeenNavigation] = useState(props.params.navigationId);
  if (props.params.navigationId !== seenNavigation) {
    setSeenNavigation(props.params.navigationId);
    if (linked) setExpanded(true);
  }
  const gt = useGT();
  const m = useMessages();
  const checks = pullRequestChecksSummary(props.pr, m);
  const action = usePullRequestAction(props.params, props.pr);
  const definition = sourceControlClients.get(props.pr.provider);
  return (
    <Animated.View layout={PR_ROW_LAYOUT}>
      <PullRequestCardRow
        title={checks.title}
        icon={checks.icon}
        tint={checks.tint}
        value={checks.count}
        compact
        accessibilityLabel={gt("Checks, {summary}", { summary: checks.label })}
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <Animated.View
          layout={PR_ROW_LAYOUT}
          entering={PR_DISCLOSURE_ENTER}
          exiting={PR_ROW_EXIT}
          className="pl-8"
        >
          {props.pr.state === "open" && props.pr.checks.some(isFailingCheck) ? (
            <PullRequestAgentRow {...props} task="feedback" title={gt("Fix failing checks")} />
          ) : null}
          {action.available("approve-workflows") ? (
            <PullRequestCardRow
              title={gt("Approve workflows")}
              icon="checkmark"
              detail={gt(
                "{count, plural, one {{count} waiting for approval} other {{count} waiting for approval}}",
                {
                  count: props.pr.workflowApprovalsRequired ?? 0,
                },
              )}
              onPress={() =>
                action.confirm(
                  "approve-workflows",
                  gt("Approve workflows"),
                  gt(
                    "Allow this {term, select, mr {merge request} cr {change request} other {pull request}}''s workflows to run? Review the workflow changes first.",
                    { term: changeRequestTermKind(definition.changeRequest) },
                  ),
                )
              }
            />
          ) : null}
          {[...props.pr.checks]
            .sort((a, b) => CHECK_PRIORITY[a.status] - CHECK_PRIORITY[b.status])
            .map((check) => {
              const status = checkStatus(check, m);
              const url = check.url;
              return (
                <PullRequestCardRow
                  key={`${check.name}:${url}`}
                  title={check.name}
                  icon={status.icon}
                  tint={status.tint}
                  value={status.label}
                  detail={check.description ?? undefined}
                  onPress={url ? () => void Linking.openURL(url) : undefined}
                />
              );
            })}
          {!props.pr.checks.length ? (
            <Text className="px-4 py-3 text-xs text-foreground-muted">
              <T>No checks reported.</T>
            </Text>
          ) : null}
          <PullRequestCardRow
            title={gt("Open checks on provider")}
            icon="arrow.up.right"
            onPress={() =>
              void Linking.openURL(
                definition.changeRequestChecksUrl?.(props.pr.url) ?? props.pr.url,
              )
            }
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

export function PullRequestBranchRow(props: RowProps) {
  const action = usePullRequestAction(props.params, props.pr);
  const agent = usePullRequestAgentActions(props.params, props.pr);
  const gt = useGT();
  const m = useMessages();
  const methods = action.available("update-branch") ? allowedUpdateMethods(props.pr) : [];
  const canResolve =
    agent.canAsk && props.pr.state === "open" && props.pr.mergeability === "conflicting";
  const summary = action.busy ? gt("Updating…") : pullRequestBranchSummary(props.pr, m);
  const clean = props.pr.mergeability === "mergeable";
  const conflicting = props.pr.mergeability === "conflicting";
  const row = (
    <PullRequestCardRow
      title={
        props.pr.mergeability === "conflicting"
          ? gt("Conflicts with {branch}", { branch: props.pr.baseBranch })
          : clean
            ? gt("No conflicts with {branch}", { branch: props.pr.baseBranch })
            : gt("Branch", { $context: "git branch" })
      }
      icon={
        conflicting ? PullRequestGlyph.conflicting : clean ? "checkmark.circle" : "arrow.branch"
      }
      tint={
        conflicting
          ? "accent-danger-foreground"
          : clean
            ? "accent-adaptive-emerald-600-400"
            : undefined
      }
      value={
        conflicting || (clean && props.pr.baseComparison !== "behind" && !action.busy)
          ? undefined
          : summary
      }
      compact
      menu={methods.length > 0 || canResolve}
      accessibilityLabel={gt("Branch, {summary}", { summary })}
    />
  );
  if (!methods.length && !canResolve) return row;
  return (
    <Menu
      title={gt("Branch", { $context: "git branch" })}
      actions={[
        ...(canResolve ? [agent.menuAction("conflicts")] : []),
        ...methods.map((id) => ({
          id,
          title: gt(
            "Update with {method, select, merge {merge} rebase {rebase} other {{method}}}",
            {
              method: id,
            },
          ),
          image: "arrow.up.circle",
        })),
      ]}
      onPressAction={({ nativeEvent }) => {
        const method = methods.find((id) => id === nativeEvent.event);
        if (method) void action.perform("update-branch", method);
        else agent.select(nativeEvent.event);
      }}
    >
      {row}
    </Menu>
  );
}

export function PullRequestReviewersRow(props: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const navigation = useNavigation();
  const gt = useGT();
  const m = useMessages();
  const activity = useEnvironmentQuery(
    composerPullRequests.activity(pullRequestTarget(props.params)),
  );
  const summary = pullRequestReviewSummary(props.pr, activity.data, m);
  const canWrite = useAtomValue(
    composerPullRequests.requestReviewers.permissionAtom(
      pullRequestTarget(props.params).environmentId,
    ),
  );
  const connected = usePullRequestConnected(props.params.environmentId);
  const canRequest =
    connected &&
    canWrite &&
    props.pr.state === "open" &&
    props.pr.capabilities.reviewers.request &&
    props.pr.viewerPermissions.requestReviewers;
  return (
    <Animated.View layout={PR_ROW_LAYOUT}>
      <PullRequestCardRow
        title={summary.title}
        icon={summary.icon}
        tint={summary.tint}
        value={summary.count}
        compact
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <Animated.View
          layout={PR_ROW_LAYOUT}
          entering={PR_DISCLOSURE_ENTER}
          exiting={PR_ROW_EXIT}
          className="pl-8"
        >
          {summary.reviews.map((review) => (
            <View
              key={review.id}
              accessibilityLabel={`${review.author?.login ?? gt("Unknown reviewer")}, ${
                review.reviewState === "APPROVED"
                  ? gt("Approved", { $context: "review state" })
                  : review.reviewState === "CHANGES_REQUESTED"
                    ? gt("Changes requested")
                    : gt("Commented", { $context: "review state" })
              }`}
              className="min-h-14 flex-row items-center gap-3 px-4 py-2"
            >
              <SymbolView
                name={
                  review.reviewState === "APPROVED"
                    ? "checkmark"
                    : review.reviewState === "CHANGES_REQUESTED"
                      ? "plusminus"
                      : "bubble.left"
                }
                size={18}
                tintColorClassName={
                  review.reviewState === "APPROVED"
                    ? "accent-adaptive-emerald-600-400"
                    : review.reviewState === "CHANGES_REQUESTED"
                      ? "accent-danger-foreground"
                      : "accent-icon-muted"
                }
              />
              <PullRequestAvatar actor={review.author} size={32} />
              <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
                {review.author?.login ?? gt("Unknown reviewer")}
              </Text>
            </View>
          ))}
          {props.pr.reviewers
            .filter(
              (reviewer) =>
                !summary.reviews.some((review) => review.author?.login === reviewer.login),
            )
            .map((reviewer) => (
              <View
                key={reviewer.login}
                accessibilityLabel={gt("{login}, Review requested", { login: reviewer.login })}
                className="min-h-14 flex-row items-center gap-3 px-4 py-2"
              >
                <SymbolView name="clock" size={18} tintColorClassName="accent-icon-muted" />
                <PullRequestAvatar actor={reviewer} size={32} />
                <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
                  {reviewer.login}
                </Text>
              </View>
            ))}
          {canRequest ? (
            <PullRequestCardRow
              title={gt("Request review")}
              icon="person.badge.plus"
              onPress={() => navigation.navigate("PullRequestReviewers", props.params)}
            />
          ) : (
            <PullRequestCardRow
              title={gt("View reviewers on provider")}
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(props.pr.url)}
            />
          )}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
