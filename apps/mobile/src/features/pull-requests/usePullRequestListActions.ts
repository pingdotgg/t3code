import * as Dialog from "../../components/ui/Dialog";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  executeAtomQuery,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestAction } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { use, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import type { MenuProps } from "../../components/ui/Menu.types";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  canPerformPullRequestAction,
  openOnProviderLabel,
  PR_ACTION_LABELS,
} from "./pullRequestActions";
import { scopedPullRequestListKey, type EnvironmentPullRequestListEntry } from "./pullRequestList";
import { copyPullRequestLink, sharePullRequestLink } from "./pullRequestLink";
import { pullRequestTarget } from "./usePullRequestDiff";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

export function usePullRequestListActions(
  environmentIds: readonly EnvironmentId[],
  onChanged: (
    entry: EnvironmentPullRequestListEntry,
    patch: Partial<EnvironmentPullRequestListEntry>,
  ) => void,
) {
  const registry = use(RegistryContext);
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const permissionKey = JSON.stringify(environmentIds);
  const permissionAtom = (() => {
    const ids: readonly EnvironmentId[] = JSON.parse(permissionKey);
    return Atom.make(
      (get) => new Set(ids.filter((id) => get(composerPullRequests.runAction.permissionAtom(id)))),
    );
  })();
  const writableEnvironments = useAtomValue(permissionAtom);
  const run = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const pending = useRef(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const params = (entry: EnvironmentPullRequestListEntry) => ({
    environmentId: String(entry.environmentId),
    projectId: String(entry.projectId),
    host: entry.host,
    repository: entry.repository,
    number: entry.number,
    initialSummary: entry,
  });
  const perform = async (
    entry: EnvironmentPullRequestListEntry,
    action: PullRequestAction | "request-review",
  ) => {
    const { environmentId } = entry;
    if (pending.current) return;
    pending.current = true;
    setBusyKey(scopedPullRequestListKey(entry));
    const result = await settlePromise(async () => {
      const target = pullRequestTarget(params(entry));
      // List rows do not subscribe to expensive detail reads.
      const response = await executeAtomQuery(registry, composerPullRequests.detail(target), {
        refresh: true,
        reportFailure: false,
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      const pr = response.value;
      if (action === "request-review") {
        if (
          !registry.get(composerPullRequests.requestReviewers.permissionAtom(environmentId)) ||
          pr.state !== "open" ||
          !pr.capabilities.reviewers.request ||
          !pr.viewerPermissions.requestReviewers
        )
          throw new Error("Review requests aren't available for this pull request.");
        if (Platform.OS === "android") {
          selectAndroidWorkspace({ name: "PullRequest", params: params(entry) }, params(entry));
        } else navigation.navigate("PullRequestReviewers", params(entry));
        return;
      }
      if (
        !registry.get(composerPullRequests.runAction.permissionAtom(environmentId)) ||
        !canPerformPullRequestAction(pr, action)
      )
        throw new Error("This action isn't available for this pull request.");
      const result = await run({ ...target, input: { ...target.input, action } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      onChanged(
        entry,
        action === "close"
          ? { state: "closed" }
          : action === "reopen"
            ? { state: "open" }
            : { isDraft: action === "draft" },
      );
    });
    pending.current = false;
    setBusyKey(null);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Couldn't update this pull request",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };
  const select = (entry: EnvironmentPullRequestListEntry, action: string) => {
    if (action === "open") {
      if (Platform.OS === "android")
        selectAndroidWorkspace({ name: "PullRequest", params: params(entry) });
      else navigation.navigate("PullRequest", params(entry));
      return;
    }
    if (action === "request-review") {
      void perform(entry, action);
      return;
    }
    if (action === "copy") {
      copyPullRequestLink(entry);
      return;
    }
    if (action === "provider") {
      void Linking.openURL(entry.url);
      return;
    }
    if (action === "share") {
      sharePullRequestLink(entry);
      return;
    }
    const supported = (["close", "reopen", "ready", "draft"] as const).find(
      (value) => value === action,
    );
    if (!supported) return;
    Dialog.alert(`${PR_ACTION_LABELS[supported]}?`, `#${entry.number} · ${entry.title}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: PR_ACTION_LABELS[supported],
        style: supported === "close" ? "destructive" : "default",
        onPress: () => void perform(entry, supported),
      },
    ]);
  };
  const actions = (entry: EnvironmentPullRequestListEntry): MenuProps["actions"] => [
    {
      id: "open",
      title: "Open pull request",
      image: Platform.OS === "ios" ? "arrow.up.right" : "open_in_new",
    },
    ...(writableEnvironments.has(entry.environmentId) && entry.state === "open"
      ? [
          {
            id: "request-review",
            title: "Request review",
            image: Platform.OS === "ios" ? "person.badge.plus" : "person_add",
          },
          {
            id: entry.isDraft ? "ready" : "draft",
            title: entry.isDraft ? "Mark ready for review" : "Convert to draft",
            image: Platform.OS === "ios" ? "pencil" : "edit",
          },
          {
            id: "close",
            title: "Close pull request",
            image: Platform.OS === "ios" ? "xmark" : "close",
            attributes: { destructive: true },
          },
        ]
      : writableEnvironments.has(entry.environmentId) && entry.state === "closed"
        ? [
            {
              id: "reopen",
              title: "Reopen pull request",
              image: Platform.OS === "ios" ? "arrow.clockwise" : "refresh",
            },
          ]
        : []),
    {
      id: "share",
      title: "Share…",
      image: Platform.OS === "ios" ? "square.and.arrow.up" : "share",
    },
    { id: "copy", title: "Copy link", image: Platform.OS === "ios" ? "link" : "link" },
    {
      id: "provider",
      title: openOnProviderLabel(entry.provider),
      image: Platform.OS === "ios" ? "safari" : "open_in_browser",
    },
  ];
  return { actions, select, busyKey };
}
