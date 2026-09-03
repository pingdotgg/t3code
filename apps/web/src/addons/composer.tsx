import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

export interface ComposerAddonContext {
  readonly targetKey: string;
  readonly environmentId: EnvironmentId;
  readonly routeKind: "draft" | "thread";
  readonly disabled: boolean;
}

export interface ComposerAddonContribution {
  readonly addonId: string;
  readonly control: ReactNode;
  readonly blockingIssue: string | null;
}

export interface ComposerAddon {
  readonly useContributions: (
    context: ComposerAddonContext,
  ) => readonly ComposerAddonContribution[];
  readonly readSubmissionPayload?: (targetKey: string) => unknown | null;
  readonly commitSubmission?: (input: {
    readonly targetKey: string;
    readonly threadId: string;
    readonly payload: unknown;
  }) => void;
  readonly clearSubmissionPayload?: (targetKey: string) => void;
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
    <div key={contribution.addonId} data-composer-addon={contribution.addonId}>
      {contribution.control}
    </div>
  ));
}
