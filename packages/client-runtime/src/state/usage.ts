import { USAGE_CONTRACT_VERSION, type EnvironmentId, type UsageSummary } from "@t3tools/contracts";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { AsyncResult } from "effect/unstable/reactivity";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export interface DerivedUsageState {
  readonly merged: MergedUsage;
  /** True until at least one compatible environment has answered. */
  readonly isPending: boolean;
  /** True after a compatible answer lands while another environment is still answering. */
  readonly isPartial: boolean;
}

/** A waiting failure is retrying; only a settled failure should surface as an error. */
export function environmentUsageStatus<E>(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly result: AsyncResult.AsyncResult<UsageSummary, E>;
}): EnvironmentUsageStatus {
  const failed = AsyncResult.isFailure(input.result) && !input.result.waiting;
  return {
    environmentId: input.environmentId,
    label: input.label,
    isPending: input.result.waiting,
    error: failed ? "This environment could not report usage." : null,
    summary: AsyncResult.isSuccess(input.result) ? input.result.value : null,
  };
}

export function deriveUsageState(
  environments: readonly EnvironmentUsageStatus[],
): DerivedUsageState {
  const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
    environment.error !== null || environment.summary === null
      ? []
      : [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            summary: environment.summary,
          },
        ],
  );
  const merged = mergeUsage(answered, USAGE_CONTRACT_VERSION);
  const compatibleAnswers = answered.filter(
    (environment) => environment.summary.contractVersion === USAGE_CONTRACT_VERSION,
  ).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    isPending: compatibleAnswers === 0 && stillReporting > 0,
    isPartial: compatibleAnswers > 0 && stillReporting > 0,
  };
}
