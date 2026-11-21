import type {
  PullRequestAction,
  PullRequestBaseComparison,
  PullRequestMergeability,
  PullRequestState,
  PullRequestUpdateMethod,
} from "@t3tools/contracts";

type PrActionKind = "ready" | "draft" | "update-branch";

export interface PrActionItem {
  readonly kind: PrActionKind;
  readonly label: string;
  /** Null when the action is available, otherwise why it is not. */
  readonly unavailable: string | null;
  /** How `update-branch` brings the base in, from what the host offers and the viewer may do. */
  readonly updateMethod?: PullRequestUpdateMethod;
}

/** The part of a pull request's detail that decides its actions, which `PullRequestDetail` satisfies. */
export interface PrActionDetail {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly baseComparison?: PullRequestBaseComparison | undefined;
  readonly capabilities: {
    readonly actions: ReadonlyArray<PullRequestAction>;
    readonly updateMethods?: ReadonlyArray<PullRequestUpdateMethod> | undefined;
  };
  readonly viewerPermissions: {
    readonly actions: ReadonlyArray<PullRequestAction>;
    readonly updateMethods?: ReadonlyArray<PullRequestUpdateMethod> | undefined;
  };
}

const allowed = (detail: PrActionDetail, kind: PrActionKind) =>
  detail.capabilities.actions.includes(kind) && detail.viewerPermissions.actions.includes(kind);

const reasonOff = (detail: PrActionDetail, kind: PrActionKind, state: string | null) =>
  state ?? (allowed(detail, kind) ? null : "Not allowed");

function updateBranch(detail: PrActionDetail): PrActionItem {
  const offered = detail.capabilities.updateMethods ?? [];
  const permitted = detail.viewerPermissions.updateMethods ?? [];
  const updateMethod = offered.find((method) => permitted.includes(method));
  const unavailable =
    detail.baseComparison === "up-to-date"
      ? "Up to date"
      : detail.baseComparison !== "behind"
        ? "Base comparison unknown"
        : detail.mergeability === "conflicting"
          ? "Resolve conflicts first"
          : detail.mergeability === "unknown"
            ? "Checking mergeability"
            : updateMethod === undefined
              ? "Not allowed"
              : reasonOff(detail, "update-branch", null);
  return {
    kind: "update-branch",
    label: "Update branch",
    unavailable,
    ...(updateMethod === undefined ? {} : { updateMethod }),
  };
}

/**
 * What the PR header's button and its menu offer, as T3 gates them. The button is marking ready or
 * updating the branch, whichever is available first, and converting to draft only ever sits in the
 * menu. Every action in the menu carries the reason it is off. A merge is not here, because it goes
 * through the For-you approval. Null when the pull request is not open.
 */
export function prActions(
  detail: PrActionDetail,
): { readonly primary: PrActionItem; readonly menu: ReadonlyArray<PrActionItem> } | null {
  if (detail.state !== "open") return null;
  const ready: PrActionItem = {
    kind: "ready",
    label: "Mark ready for review",
    unavailable: reasonOff(detail, "ready", detail.isDraft ? null : "Already ready"),
  };
  const draft: PrActionItem = {
    kind: "draft",
    label: "Convert to draft",
    unavailable: reasonOff(detail, "draft", detail.isDraft ? "Already a draft" : null),
  };
  const update = updateBranch(detail);
  const primary =
    [ready, update].find((action) => action.unavailable === null) ??
    (detail.isDraft ? ready : update);
  return { primary, menu: [ready, update, draft].filter((action) => action !== primary) };
}
