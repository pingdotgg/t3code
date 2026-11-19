import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  PullRequestDetail,
  PullRequestListEntry,
  PullRequestSummary,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react-native";
import * as Clipboard from "expo-clipboard";
import { Linking, Pressable, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { composerPullRequests } from "../../state/pull-requests";
import { KvIcon, KvRow, KvText, TabActions } from "../detail/DetailLayout";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { PullRequestAgentRow } from "./PullRequestAgentRow";
import { PullRequestCardRow } from "./PullRequestControls";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { usePullRequestAction } from "./usePullRequestAction";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestLabelColor } from "./pullRequestList";
import {
  checkStatus,
  isFailingCheck,
  pullRequestChecksSummary,
  pullRequestStatus,
} from "./pullRequestStatus";
import {
  pullRequestTarget,
  type PullRequestParams,
  type PullRequestTaskLink,
} from "./usePullRequestDiff";

type Identity = PullRequestDetail | PullRequestListEntry | PullRequestSummary;

/**
 * The Orbit task a pull request belongs to. Orbit has no PR-to-task lookup yet (Orbit task 6042),
 * so only a PR opened from its task knows it; this is where that lookup plugs in.
 */
export function pullRequestTask(params: PullRequestParams): PullRequestTaskLink | null {
  return params.fromTask ?? null;
}

function Diff(props: { readonly additions: number; readonly deletions: number }) {
  return (
    <>
      <KvText className="shrink-0 tabular-nums text-adaptive-emerald-600-400">
        +{props.additions.toLocaleString()}
      </KvText>
      <KvText className="shrink-0 tabular-nums text-danger-foreground">
        −{props.deletions.toLocaleString()}
      </KvText>
    </>
  );
}

function LabelPills(props: { readonly labels: PullRequestDetail["labels"] }) {
  return (
    <View className="min-w-0 flex-1 flex-row flex-wrap gap-1.5 py-2">
      {props.labels.map((label) => {
        const color = pullRequestLabelColor(label.color);
        return (
          <View
            key={label.name}
            className={cn(
              "h-6 justify-center rounded-full px-2.5 pb-px",
              !color && "bg-grouped-card",
            )}
            style={color ? { backgroundColor: `${color}26` } : undefined}
          >
            <Text
              className={cn("text-[14px]", !color && "text-foreground-muted")}
              style={color ? { color } : undefined}
              numberOfLines={1}
            >
              {label.name}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The pull request's facts under its title: where it lives, its task, who and when, the branch,
 * the size, reviewers and labels.
 */
export function PullRequestKeyValues(props: {
  readonly pr: Identity;
  readonly params: PullRequestParams;
  readonly onOpenTask: (task: PullRequestTaskLink) => void;
}) {
  const { pr, params } = props;
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const connected = usePullRequestConnected(params.environmentId);
  const environmentId = pullRequestTarget(params).environmentId;
  const canWriteLabels = useAtomValue(composerPullRequests.setLabels.permissionAtom(environmentId));
  const canWriteReviewers = useAtomValue(
    composerPullRequests.requestReviewers.permissionAtom(environmentId),
  );
  const status = pullRequestStatus({ state: pr.state, isDraft: pr.isDraft === true }, messages);
  const task = pullRequestTask(params);
  const detail = "capabilities" in pr ? pr : null;
  const labelsEditable =
    detail !== null &&
    connected &&
    canWriteLabels &&
    detail.capabilities.labels === true &&
    detail.viewerPermissions.labels !== false;
  const canRequest =
    detail !== null &&
    connected &&
    canWriteReviewers &&
    detail.state === "open" &&
    detail.capabilities.reviewers.request &&
    detail.viewerPermissions.requestReviewers;
  const changedFiles = "changedFiles" in pr ? pr.changedFiles : undefined;
  return (
    <>
      <KvRow icon={<KvIcon name="folder" />} label={gt("Repository")}>
        {pr.repository}
      </KvRow>
      <KvRow
        icon={<KvIcon name="link" />}
        label={gt("Link")}
        external
        accessibilityLabel={gt("Open #{number} on the host", { number: pr.number })}
        onPress={() => void Linking.openURL(pr.url)}
      >
        <KvText className={cn("shrink-0 tabular-nums", status.text)}>#{pr.number}</KvText>
        <SymbolView
          name="arrow.up.right"
          size={12}
          weight="semibold"
          tintColorClassName={status.tint}
        />
      </KvRow>
      {task ? (
        <KvRow
          icon={<KvIcon name="checklist" />}
          label={gt("Task")}
          onPress={() => props.onOpenTask(task)}
        >
          <KvText className="shrink-0 tabular-nums text-foreground-muted">#{task.id}</KvText>
          <KvText>{task.title}</KvText>
        </KvRow>
      ) : null}
      <KvRow icon={<KvIcon name="person.crop.circle" />} label={gt("Author")}>
        <PullRequestAvatar actor={pr.author ?? null} size={20} />
        <KvText>{pr.author?.login ?? gt("Unknown author")}</KvText>
      </KvRow>
      <KvRow icon={<KvIcon name="clock" />} label={gt("Updated at")}>
        <KvText className="text-foreground-muted">
          <T>
            <Var>
              <RelativeTime timestamp={pr.updatedAt} />
            </Var>{" "}
            ago
          </T>
        </KvText>
      </KvRow>
      <KvRow icon={<KvIcon name="arrow.triangle.branch" />} label={gt("Branch")}>
        {/* Each branch name copies itself, as the old header's branch line did. */}
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-1.5 py-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Copy head branch {branch}", { branch: pr.headBranch })}
            onPress={() => void Clipboard.setStringAsync(pr.headBranch)}
            className="min-w-0 shrink active:opacity-70"
            hitSlop={4}
          >
            <Text className="text-[15px] leading-6 text-foreground-muted">{pr.headBranch}</Text>
          </Pressable>
          <Text className="text-[15px] leading-6 text-foreground-tertiary">
            {gt("into", { $context: "head branch into base branch" })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Copy base branch {branch}", { branch: pr.baseBranch })}
            onPress={() => void Clipboard.setStringAsync(pr.baseBranch)}
            className="min-w-0 shrink active:opacity-70"
            hitSlop={4}
          >
            <Text className="text-[15px] leading-6 text-foreground-muted">{pr.baseBranch}</Text>
          </Pressable>
        </View>
      </KvRow>
      <KvRow icon={<KvIcon name="plusminus" />} label={gt("Changes")}>
        {changedFiles !== undefined ? (
          <KvText className="shrink-0 tabular-nums">
            {gt("{count, plural, one {{count} file} other {{count} files}}", {
              count: changedFiles,
            })}
          </KvText>
        ) : null}
        <Diff additions={pr.additions ?? 0} deletions={pr.deletions ?? 0} />
      </KvRow>
      {detail ? (
        <KvRow
          icon={<KvIcon name="person.2" />}
          label={gt("Reviewers")}
          {...(canRequest
            ? { onPress: () => navigation.navigate("PullRequestReviewers", params) }
            : {})}
        >
          {detail.reviewers.length ? (
            detail.reviewers.map((reviewer) => (
              <PullRequestAvatar key={reviewer.login} actor={reviewer} size={22} />
            ))
          ) : (
            <KvText className="text-foreground-muted">
              {gt("None", { $context: "no reviewers" })}
            </KvText>
          )}
        </KvRow>
      ) : null}
      {detail && (detail.labels.length > 0 || labelsEditable) ? (
        <KvRow
          icon={<KvIcon name="tag" />}
          label={gt("Labels")}
          {...(labelsEditable
            ? { onPress: () => navigation.navigate("PullRequestLabels", params) }
            : {})}
        >
          {detail.labels.length ? (
            <LabelPills labels={detail.labels} />
          ) : (
            <KvText className="text-foreground-muted">{gt("Add labels")}</KvText>
          )}
        </KvRow>
      ) : null}
    </>
  );
}

const CHECK_PRIORITY = {
  failure: 0,
  "action-required": 1,
  pending: 2,
  cancelled: 3,
  neutral: 4,
  skipped: 5,
  success: 6,
};

/** A check or action row: no chevron, a press fill 7pt in, 11pt from the fill to the content. */
function CheckRow(props: {
  readonly icon: AppSymbolName;
  readonly tint: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly value?: string;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? "link" : undefined}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="mx-[7px]"
    >
      {({ pressed }) => (
        <View
          className={cn(
            "flex-row items-start gap-3 rounded-xl p-[11px]",
            pressed && "bg-row-hover",
          )}
        >
          <View className="h-[22px] justify-center">
            <SymbolView
              name={props.icon}
              size={16}
              weight="medium"
              tintColorClassName={props.tint}
            />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-[15px] leading-[22px] text-foreground" numberOfLines={2}>
              {props.title}
            </Text>
            {props.detail ? (
              <Text className="text-[13px] leading-5 text-foreground-muted" numberOfLines={2}>
                {props.detail}
              </Text>
            ) : null}
          </View>
          {props.value ? (
            <Text className="text-[15px] leading-[22px] text-foreground-muted">{props.value}</Text>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

/** The Checks tab: a summary line, then each check with its status. */
export function PullRequestChecksTab(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
}) {
  const { pr } = props;
  const gt = useGT();
  const m = useMessages();
  const action = usePullRequestAction(props.params, pr);
  const definition = sourceControlClients.get(pr.provider);
  const summary = pullRequestChecksSummary(pr, m);
  const pending = pr.checks.filter((check) => check.status === "pending").length;
  return (
    <View>
      <TabActions>
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <SymbolView
            name={summary.icon}
            size={16}
            weight="medium"
            tintColorClassName={summary.tint}
          />
          <Text className="min-w-0 flex-1 text-[15px] text-foreground" numberOfLines={1}>
            {pending
              ? gt("{count} of {total} checks running", { count: pending, total: pr.checks.length })
              : summary.title}
          </Text>
        </View>
      </TabActions>
      <View className="px-4">
        {pr.state === "open" && pr.checks.some(isFailingCheck) ? (
          <PullRequestAgentRow {...props} task="feedback" title={gt("Fix failing checks")} />
        ) : null}
        {action.available("approve-workflows") ? (
          <PullRequestCardRow
            title={gt("Approve workflows")}
            icon="checkmark"
            detail={gt(
              "{count, plural, one {{count} waiting for approval} other {{count} waiting for approval}}",
              { count: pr.workflowApprovalsRequired ?? 0 },
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
      </View>
      <View className="py-1">
        {[...pr.checks]
          .sort((a, b) => CHECK_PRIORITY[a.status] - CHECK_PRIORITY[b.status])
          .map((check) => {
            const status = checkStatus(check, m);
            const url = check.url;
            return (
              <CheckRow
                key={`${check.name}:${url}`}
                icon={status.icon}
                tint={status.tint}
                title={check.name}
                detail={check.description}
                value={status.label}
                {...(url ? { onPress: () => void Linking.openURL(url) } : {})}
              />
            );
          })}
        {!pr.checks.length ? (
          <Text className="px-4 py-3 text-[15px] text-foreground-muted">
            <T>No checks reported.</T>
          </Text>
        ) : null}
        <CheckRow
          icon="arrow.up.right"
          tint="accent-icon-muted"
          title={gt("Open checks on provider")}
          onPress={() =>
            void Linking.openURL(definition.changeRequestChecksUrl?.(pr.url) ?? pr.url)
          }
        />
      </View>
    </View>
  );
}
