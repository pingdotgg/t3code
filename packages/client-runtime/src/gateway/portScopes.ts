import type { GatewayScope } from "@t3tools/contracts";

import type { GatewayGrants } from "./bridgeClient.ts";
import type { GatewayRuntimePort } from "./port.ts";
import { gatewayPortEnvironmentIds } from "./routedPort.ts";

/** What a relayed runtime port call needs on one environment: every scope of any one set. */
export interface GatewayScopeRequirement {
  readonly environmentId: string;
  readonly anyOf: ReadonlyArray<ReadonlyArray<GatewayScope>>;
}

type Needs = GatewayScopeRequirement["anyOf"];

const READ: Needs = [["read"]];
const WRITE: Needs = [["create"], ["admin"]];
const LIFECYCLE: Needs = [["lifecycle"]];
const REVIEW: Needs = [["review"]];

const action = (args: ReadonlyArray<unknown>): unknown => {
  const request = args[1];
  return typeof request === "object" && request !== null
    ? (request as { readonly action?: unknown }).action
    : undefined;
};

const OPERATION_NEEDS: Readonly<Record<string, Needs>> = {
  "git.status": READ,
  "git.diff": READ,
  "git.apply_patch": [["admin"]],
  "git.create_branch": [["admin"]],
  "git.commit": [["admin"]],
  "git.create_pr": REVIEW,
  "pr.update": REVIEW,
  "pr.reply": REVIEW,
  "pr.apply_review_fixes": REVIEW,
  "pr.publish": [["review", "admin"]],
};

/**
 * The scopes each port call needs, matching what its gateway tools check. A relayed call runs
 * only on an app whose own grant meets them, so no app's grant widens a call another app serves.
 */
const METHOD_NEEDS: {
  readonly [M in keyof GatewayRuntimePort]-?: (args: ReadonlyArray<unknown>) => Needs;
} = {
  openThread: () => READ,
  openAgents: () => READ,
  listDevices: () => READ,
  focusDevice: () => READ,
  scheduledTask: (args) =>
    action(args) === "list" ? READ : action(args) === "run" ? [["send"]] : WRITE,
  todo: (args) => (action(args) === "list" ? READ : WRITE),
  threadTask: (args) => {
    const kind = action(args);
    if (kind === "read" || kind === "watch" || kind === "board" || kind === "projectSnapshot") {
      return READ;
    }
    return kind === "settleAfterTurn" ? LIFECYCLE : WRITE;
  },
  // Its source environment is handled in gatewayPortCallScopes.
  handoffThread: () => [["create", "send", "artifact"]],
  settleThread: () => LIFECYCLE,
  unsettleThread: () => LIFECYCLE,
  setThreadParent: () => LIFECYCLE,
  listSkills: () => READ,
  createSkill: () => WRITE,
  updateSkill: () => WRITE,
  deleteSkill: () => WRITE,
  createProfile: () => WRITE,
  updateProfile: () => WRITE,
  deleteProfile: () => WRITE,
  replicateProfiles: () => WRITE,
  syncAgentLibrary: () => WRITE,
  listEnvironments: () => [],
  getEnvironmentStatus: () => READ,
  getPresence: () => READ,
  listProfiles: () => READ,
  resolveProfileModelSelection: () => READ,
  listProjects: () => READ,
  listThreads: () => READ,
  getThread: () => READ,
  hasThreadMessage: () => READ,
  getPullRequest: () => REVIEW,
  getPullRequestActivity: () => REVIEW,
  getCommandReceipts: () => READ,
  createThread: () => [["create"]],
  sendMessage: () => [["send"]],
  controlThread: () => [["control"], ["lifecycle"]],
  respondToApproval: () => [["approval"]],
  respondToUserInput: () => [["send"]],
  executeOperation: (args) => {
    const input = (args[0] ?? {}) as { readonly operation?: unknown; readonly payload?: unknown };
    if (input.operation === "worktree.reclaim") {
      const payload = input.payload as { readonly dryRun?: unknown } | undefined;
      return payload?.dryRun === true ? READ : LIFECYCLE;
    }
    // An operation this table does not know needs every scope it could.
    return OPERATION_NEEDS[String(input.operation)] ?? [["admin"]];
  },
};

/** What a relayed port call needs on each environment it touches; empty when it names none. */
export function gatewayPortCallScopes(
  method: keyof GatewayRuntimePort,
  args: ReadonlyArray<unknown>,
): ReadonlyArray<GatewayScopeRequirement> {
  const needs = METHOD_NEEDS[method];
  if (needs === undefined) return [];
  if (method === "handoffThread") {
    const input = (args[0] ?? {}) as {
      readonly environmentId?: unknown;
      readonly sourceEnvironmentId?: unknown;
      readonly files?: ReadonlyArray<unknown>;
    };
    if (typeof input.environmentId !== "string" || typeof input.sourceEnvironmentId !== "string") {
      return [];
    }
    return [
      { environmentId: input.environmentId, anyOf: needs(args) },
      {
        environmentId: input.sourceEnvironmentId,
        anyOf: input.files?.length ? [["read", "artifact"]] : READ,
      },
    ];
  }
  const anyOf = needs(args);
  return gatewayPortEnvironmentIds(args).map((environmentId) => ({ environmentId, anyOf }));
}

/** The first requirement `grants` does not meet, or undefined when it meets them all. */
export function unmetGatewayScopes(
  grants: GatewayGrants,
  requirements: ReadonlyArray<GatewayScopeRequirement>,
): GatewayScopeRequirement | undefined {
  return requirements.find(({ environmentId, anyOf }) => {
    const held = grants[environmentId];
    return (
      held === undefined ||
      (anyOf.length > 0 && !anyOf.some((set) => set.every((scope) => held.includes(scope))))
    );
  });
}

export function describeGatewayScopes(requirement: GatewayScopeRequirement): string {
  return requirement.anyOf.map((set) => set.join(" and ")).join(" or ");
}
