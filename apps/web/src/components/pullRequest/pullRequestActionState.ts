import {
  PullRequestActionInput,
  PullRequestActionOutcome,
  type PullRequestActionOutcome as PullRequestActionOutcomeType,
} from "@t3tools/contracts";
import { Schema } from "effect";

type ActionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StoredPullRequestAction = {
  readonly input: PullRequestActionInput;
  readonly operation?: PullRequestActionOutcomeType["operation"] | undefined;
  readonly state: "pending" | "failed" | "unknown";
  readonly detail: string;
};

export const pullRequestActionScopeKey = (environmentId: string, input: PullRequestActionInput) =>
  `t3.pullRequests.action:${JSON.stringify([
    environmentId,
    input.projectId,
    input.host?.toLowerCase() ?? null,
    input.repository.toLowerCase(),
    ...(input.stackNumber === undefined
      ? ["pull-request", input.number]
      : ["stack", input.stackNumber]),
  ])}`;

const decodeInput = Schema.decodeUnknownOption(PullRequestActionInput);
const decodeOutcome = Schema.decodeUnknownOption(PullRequestActionOutcome);

export const decodePullRequestActionOutcome = (
  value: unknown,
): PullRequestActionOutcomeType | null => {
  const decoded = decodeOutcome(value);
  return decoded._tag === "Some" ? decoded.value : null;
};

const sameScope = (left: PullRequestActionInput, right: PullRequestActionInput) =>
  left.projectId === right.projectId &&
  (left.host?.toLowerCase() ?? null) === (right.host?.toLowerCase() ?? null) &&
  left.repository.toLowerCase() === right.repository.toLowerCase() &&
  (left.stackNumber === undefined
    ? right.stackNumber === undefined && left.number === right.number
    : left.stackNumber === right.stackNumber);

export function readStoredPullRequestAction(
  storage: ActionStorage | undefined,
  environmentId: string,
  scope: PullRequestActionInput,
): StoredPullRequestAction | null {
  try {
    const raw = storage?.getItem(pullRequestActionScopeKey(environmentId, scope));
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const input = decodeInput(value.input);
    if (
      input._tag === "None" ||
      input.value.requestId === undefined ||
      !sameScope(input.value, scope) ||
      (value.state !== "pending" && value.state !== "failed" && value.state !== "unknown") ||
      typeof value.detail !== "string"
    )
      return null;
    const operation =
      value.operation === undefined
        ? undefined
        : decodePullRequestActionOutcome({
            operation: value.operation,
            state: "pending",
            detail: "",
          })?.operation;
    if (value.operation !== undefined && operation === undefined) return null;
    return {
      input: input.value,
      ...(operation === undefined ? {} : { operation }),
      state: value.state,
      detail: value.detail,
    } as StoredPullRequestAction;
  } catch {
    return null;
  }
}

export function writeStoredPullRequestAction(
  storage: ActionStorage | undefined,
  environmentId: string,
  action: StoredPullRequestAction | null,
  scope: PullRequestActionInput,
): void {
  try {
    const key = pullRequestActionScopeKey(environmentId, scope);
    if (action === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(action));
  } catch {
    // Losing recovery state to unavailable session storage must not hide the in-memory result.
  }
}

export function inspectionInput(
  action: StoredPullRequestAction,
  discoveryOperation?: PullRequestActionOutcomeType["operation"],
): PullRequestActionInput | null {
  const operation = action.operation ?? discoveryOperation;
  if (!operation) return null;
  return { ...action.input, operation };
}
