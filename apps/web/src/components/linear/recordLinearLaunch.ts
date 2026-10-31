import type {
  EnvironmentId,
  LinearLaunchTarget,
  LinearRecordLaunchInput,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { toastManager } from "../ui/toast";
import { linearThreadUrl } from "./linearLaunch.logic";

/**
 * Links a launch that actually happened to its issue and runs the write-backs. Never throws and
 * never blocks the launch: a failure is a warning toast, and the launch stands unlinked.
 */
export async function recordLinearLaunch(input: {
  readonly environmentId: EnvironmentId;
  readonly issueId: string;
  readonly identifier: string;
  /** Ids the client already holds, so the launch is linked even when Linear can't be read. */
  readonly teamId: string | undefined;
  readonly projectId: string | undefined;
  readonly target: LinearLaunchTarget;
  readonly writeBack: LinearRecordLaunchInput["writeBack"];
}): Promise<void> {
  // Linear is served by the primary environment only.
  if (readPrimaryEnvironmentId() !== input.environmentId) return;
  const warn = (description: string) =>
    toastManager.add({
      type: "warning",
      title: `Could not update ${input.identifier} in Linear`,
      description,
    });
  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      linearEnvironment.recordLaunch,
      {
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
            // The desktop app's custom scheme can't be opened from Linear.
            origin: /^https?:$/u.test(window.location.protocol)
              ? window.location.origin
              : configuredHostedAppUrl(),
            environmentId: input.environmentId,
            threadId: input.target.threadId,
          }),
        },
      },
      { label: "linear record launch", reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      warn(
        failure instanceof Error && failure.message.length > 0
          ? failure.message
          : "The launch started, but the issue was not linked.",
      );
      return;
    }
    const [first] = result.value.warnings;
    if (first) warn(first.message);
  } catch {
    warn("The launch started, but the issue was not linked.");
  }
}
