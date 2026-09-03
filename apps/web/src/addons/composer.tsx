import type { EnvironmentId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";

export interface ComposerAddonContext {
  readonly targetKey: string;
  readonly environmentId: EnvironmentId;
  readonly routeKind: "draft" | "thread";
  readonly disabled: boolean;
}

export interface ComposerAddonContribution {
  readonly addonId: string;
  /** Stable within one addon; combined with addonId for the React key. */
  readonly contributionId: string;
  readonly control: ReactNode;
  readonly blockingIssue: string | null;
}

export type ComposerAddonContributionInput = Omit<ComposerAddonContribution, "addonId">;

export interface ComposerAddonSubmissionPayload {
  /** Changes whenever the staged payload changes. */
  readonly revision: string;
  readonly payload: unknown;
}

export interface ComposerAddon {
  readonly useContributions: (
    context: ComposerAddonContext,
  ) => readonly ComposerAddonContributionInput[];
  readonly readSubmissionPayload?: (targetKey: string) => ComposerAddonSubmissionPayload | null;
  readonly commitSubmission?: (input: {
    readonly targetKey: string;
    readonly threadRef: ScopedThreadRef;
    readonly revision: string;
    readonly payload: unknown;
  }) => void | Promise<void>;
  /**
   * Atomically clear only when the addon's current revision still equals
   * expectedRevision. This preserves edits made while an earlier send ran.
   */
  readonly clearSubmissionPayload?: (input: {
    readonly targetKey: string;
    readonly expectedRevision: string;
    readonly reason: "discarded" | "submitted";
  }) => void | Promise<void>;
}

export function composerAddonBlockingIssue(
  contributions: readonly ComposerAddonContribution[],
): string | null {
  return (
    contributions.find((contribution) => contribution.blockingIssue !== null)?.blockingIssue ?? null
  );
}

export function ComposerAddonSlot(props: {
  readonly contributions: readonly ComposerAddonContribution[];
}) {
  if (props.contributions.length === 0) return null;

  return props.contributions.map((contribution) => (
    <div
      key={`${contribution.addonId}:${contribution.contributionId}`}
      data-composer-addon={contribution.addonId}
      data-composer-addon-contribution={contribution.contributionId}
    >
      {contribution.control}
    </div>
  ));
}
