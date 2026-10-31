import type {
  EnvironmentId,
  LinearLaunchTarget,
  LinearRecordLaunchInput,
} from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { runAtomCommand, squashAtomCommandFailure } from "../state/runtime.ts";
import type { LinearEnvironmentAtoms } from "../state/linear.ts";
import { linearThreadUrl } from "./launchPlan.ts";

export interface RecordLinearLaunchInput {
  readonly environmentId: EnvironmentId;
  readonly issueId: string;
  readonly identifier: string;
  /** Ids the client already holds, so the launch is linked even when Linear can't be read. */
  readonly teamId: string | undefined;
  readonly projectId: string | undefined;
  readonly target: LinearLaunchTarget;
  readonly writeBack: LinearRecordLaunchInput["writeBack"];
}

/** The client's side of the call: its registry, the record-launch command, and a linkable origin. */
export interface RecordLinearLaunchDeps {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly recordLaunch: LinearEnvironmentAtoms["recordLaunch"];
  /** An http(s) origin Linear can open; the desktop app's custom scheme can't be. */
  readonly threadOrigin: string;
}

function buildLinearRecordLaunchRequest(input: RecordLinearLaunchInput, threadOrigin: string) {
  return {
    environmentId: input.environmentId,
    input: {
      issueId: input.issueId,
      target: input.target,
      writeBack: input.writeBack,
      ...(input.teamId === undefined
        ? {}
        : {
            issue: {
              identifier: input.identifier,
              teamId: input.teamId,
              ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            },
          }),
      threadUrl: linearThreadUrl({
        origin: threadOrigin,
        environmentId: input.environmentId,
        threadId: input.target.threadId,
      }),
    },
  } satisfies { environmentId: EnvironmentId; input: LinearRecordLaunchInput };
}

/**
 * Links a launch that actually happened to its issue and runs the write-backs. Never throws and
 * never blocks the launch. Resolves to a warning for the client to show, or null when all went well.
 */
export async function recordLinearLaunch(
  deps: RecordLinearLaunchDeps,
  input: RecordLinearLaunchInput,
): Promise<string | null> {
  try {
    const result = await runAtomCommand(
      deps.registry,
      deps.recordLaunch,
      buildLinearRecordLaunchRequest(input, deps.threadOrigin),
      { label: "linear record launch", reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      return failure instanceof Error && failure.message.length > 0
        ? failure.message
        : "The launch started, but the issue was not linked.";
    }
    return result.value.warnings[0]?.message ?? null;
  } catch {
    return "The launch started, but the issue was not linked.";
  }
}
