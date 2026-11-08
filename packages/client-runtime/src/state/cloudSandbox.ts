import {
  type BoatSandboxSize,
  type CloudSandboxProfileStatus,
  type EnvironmentId,
  type ManagedCloudSandboxControlOperation,
  type ManagedCloudSandboxResource,
  type ManagedCloudSandboxResourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import {
  deleteManagedSandbox as deleteControllerSandbox,
  listManagedSandboxes,
} from "../connection/cloudSandbox.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createRuntimeCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";

export const BOAT_SIZE_LABELS: Record<BoatSandboxSize, string> = {
  small: "Small",
  default: "Standard",
  large: "Large",
  xlarge: "Extra Large",
};

const CLOUD_SANDBOX_PHASE_LABELS: Record<ManagedCloudSandboxResource["phase"], string> = {
  allocating: "Starting",
  connecting: "Connecting",
  connected: "Running",
  disconnected: "Disconnected",
  stopped: "Stopped",
  deleting: "Deleting",
  deleted: "Deleted",
  failed: "Failed",
};

const usd = (amount: number) => (amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`);

export function describeCloudSandboxProfile(
  { profile, spend }: CloudSandboxProfileStatus,
  running: number,
): string {
  const size =
    profile.defaultSize === null ? "No default size" : BOAT_SIZE_LABELS[profile.defaultSize];
  const autoStop =
    profile.autoStopMinutes % 60 === 0
      ? `${profile.autoStopMinutes / 60} h`
      : `${profile.autoStopMinutes} min`;
  const budget =
    profile.monthlyBudgetUsd === null
      ? "No budget limit"
      : `${usd(spend?.usd ?? 0)} from deleted sandboxes of ${usd(profile.monthlyBudgetUsd)} this month`;
  return [
    size,
    `Auto-stop ${autoStop}`,
    budget,
    `${running} running of ${profile.maxConcurrentSandboxes} allowed`,
  ].join(" · ");
}

export function describeCloudSandbox(resource: ManagedCloudSandboxResource): string {
  return [CLOUD_SANDBOX_PHASE_LABELS[resource.phase], resource.sandboxId]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function countRunningCloudSandboxes(
  resources: readonly ManagedCloudSandboxResource[],
  profileId: CloudSandboxProfileStatus["profile"]["profileId"],
): number {
  return resources.filter(
    (resource) =>
      resource.profileId === profileId &&
      resource.phase !== "stopped" &&
      resource.phase !== "failed",
  ).length;
}

/** Stop and resume are offered only in these phases; resume for a stopped sandbox. */
export function offersCloudSandboxControl(phase: ManagedCloudSandboxResource["phase"]): boolean {
  return (
    phase === "connected" ||
    phase === "connecting" ||
    phase === "disconnected" ||
    phase === "stopped"
  );
}

export function cloudSandboxControlOperation(
  resource: ManagedCloudSandboxResource,
): ManagedCloudSandboxControlOperation {
  return resource.phase === "stopped" ? { _tag: "resume" } : { _tag: "stop" };
}

export interface SandboxProfileLimits {
  readonly monthlyBudgetUsd: number | null;
  readonly maxConcurrentSandboxes: number;
  readonly template: string | null;
}

const DECIMAL_PATTERN = /^(\d+\.?\d*|\.\d+)$/u;

/** Checks what a profile form typed before it reaches the server, which enforces the same ranges. */
export function parseSandboxProfileLimits(input: {
  readonly monthlyBudgetUsd: string;
  readonly maxConcurrentSandboxes: number;
  readonly template: string;
}): Result.Result<SandboxProfileLimits, string> {
  const budgetText = input.monthlyBudgetUsd.trim();
  const budget = budgetText === "" ? null : Number(budgetText);
  if (budget !== null && (!DECIMAL_PATTERN.test(budgetText) || !(budget > 0))) {
    return Result.fail("Monthly budget must be a dollar amount above 0, or blank for no limit.");
  }
  if (
    !Number.isInteger(input.maxConcurrentSandboxes) ||
    input.maxConcurrentSandboxes < 1 ||
    input.maxConcurrentSandboxes > 100
  ) {
    return Result.fail("Concurrent sandboxes must be a whole number from 1 to 100.");
  }
  const template = input.template.trim();
  return Result.succeed({
    monthlyBudgetUsd: budget,
    maxConcurrentSandboxes: input.maxConcurrentSandboxes,
    template: template === "" ? null : template,
  });
}

/** Null when the command succeeded or was interrupted, so the caller can clear the error. */
export function cloudSandboxFailureMessage<A, E>(
  result: AtomCommandResult<A, E>,
  fallback: string,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error: unknown = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "detail" in error) {
    if (typeof error.detail === "string") return error.detail;
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Every managed sandbox a controller reports, polled every 30 seconds while subscribed. The
 * polling stops when the last subscriber leaves, and deleted resources are left out.
 */
export function createManagedSandboxAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const list = Atom.family((controllerEnvironmentId: EnvironmentId) =>
    runtime
      .atom(
        Stream.fromEffect(
          listManagedSandboxes(controllerEnvironmentId).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Managed cloud sandbox list failed", error),
            ),
            Effect.map((resources): readonly ManagedCloudSandboxResource[] =>
              resources.filter((resource) => resource.phase !== "deleted"),
            ),
            Effect.orElseSucceed((): readonly ManagedCloudSandboxResource[] => []),
          ),
        ).pipe(Stream.repeat(Schedule.spaced("30 seconds"))),
      )
      .pipe(Atom.setIdleTTL(0)),
  );
  const remove = createRuntimeCommand(runtime, {
    label: "environment-data:cloud-sandbox:delete-managed",
    execute: Effect.fn("clientRuntime.cloudSandbox.deleteManagedSandboxCommand")(function* (input: {
      readonly controllerEnvironmentId: EnvironmentId;
      readonly resourceId: ManagedCloudSandboxResourceId;
    }) {
      return yield* deleteControllerSandbox(input.controllerEnvironmentId, input.resourceId);
    }),
  });
  return { list, remove };
}
