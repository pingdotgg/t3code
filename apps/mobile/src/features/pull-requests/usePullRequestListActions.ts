import * as Dialog from "../../components/ui/Dialog";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  executeAtomQuery,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestAction } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { use, useRef, useState } from "react";
import { Linking } from "react-native";
import type { MenuProps } from "../../components/ui/Menu.types";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  canPerformPullRequestAction,
  openOnProviderLabel,
  pullRequestActionLabel,
} from "./pullRequestActions";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { scopedPullRequestListKey, type EnvironmentPullRequestListEntry } from "./pullRequestList";
import { copyPullRequestLink, sharePullRequestLink } from "./pullRequestLink";
import { pullRequestTarget } from "./usePullRequestDiff";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";

export function usePullRequestListActions(
  environmentIds: readonly EnvironmentId[],
  onChanged: (
    entry: EnvironmentPullRequestListEntry,
    patch: Partial<EnvironmentPullRequestListEntry>,
  ) => void,
) {
  const registry = use(RegistryContext);
  const selectDetail = useSelectWorkspaceDetail();
  const openDetail = useOpenWorkspaceDetail();
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
    const terminology = sourceControlClients.get(entry.provider).changeRequest;
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
          throw new Error(`Review requests aren't available for this ${terminology.singular}.`);
        openDetail(
          { name: "PullRequest", params: params(entry) },
          { name: "PullRequestReviewers", params: params(entry) },
        );
        return;
      }
      if (
        !registry.get(composerPullRequests.runAction.permissionAtom(environmentId)) ||
        !canPerformPullRequestAction(pr, action)
      )
        throw new Error(`This action isn't available for this ${terminology.singular}.`);
      const result = await run({ ...target, input: { ...target.input, action } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value !== undefined) return;
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
        `Couldn't update this ${terminology.singular}`,
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };
  const select = (entry: EnvironmentPullRequestListEntry, action: string) => {
    if (action === "open") {
      selectDetail({ name: "PullRequest", params: params(entry) });
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
    const label = pullRequestActionLabel(
      supported,
      sourceControlClients.get(entry.provider).changeRequest,
    );
    Dialog.alert(`${label}?`, `#${entry.number} · ${entry.title}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: label,
        style: supported === "close" ? "destructive" : "default",
        onPress: () => void perform(entry, supported),
      },
    ]);
  };
  const actions = (entry: EnvironmentPullRequestListEntry): MenuProps["actions"] => {
    const terminology = sourceControlClients.get(entry.provider).changeRequest;
    return [
      {
        id: "open",
        title: `Open ${terminology.singular}`,
        image: "arrow.up.right",
      },
      ...(writableEnvironments.has(entry.environmentId) && entry.state === "open"
        ? [
            {
              id: "request-review",
              title: "Request review",
              image: "person.badge.plus",
            },
            {
              id: entry.isDraft ? "ready" : "draft",
              title: entry.isDraft ? "Mark ready for review" : "Convert to draft",
              image: "pencil",
            },
            {
              id: "close",
              title: pullRequestActionLabel("close", terminology),
              image: "xmark",
              attributes: { destructive: true },
            },
          ]
        : writableEnvironments.has(entry.environmentId) && entry.state === "closed"
          ? [
              {
                id: "reopen",
                title: pullRequestActionLabel("reopen", terminology),
                image: "arrow.clockwise",
              },
            ]
          : []),
      {
        id: "share",
        title: "Share…",
        image: "square.and.arrow.up",
      },
      { id: "copy", title: "Copy link", image: "link" },
      {
        id: "provider",
        title: openOnProviderLabel(entry.provider),
        image: "safari",
      },
    ];
  };
  return { actions, select, busyKey };
}
