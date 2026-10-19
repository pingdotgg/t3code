import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

type ThreadStartMarkers = Pick<
  EnvironmentThreadShell,
  "latestRun" | "latestUserMessageAt" | "runtime"
>;

function threadShellHasStarted(thread: ThreadStartMarkers | null | undefined): boolean {
  return Boolean(
    thread &&
    (thread.latestRun !== null || thread.latestUserMessageAt !== null || thread.runtime !== null),
  );
}

export function threadAllowsProviderSwitch(input: {
  readonly thread: ThreadStartMarkers | null | undefined;
  readonly projection: OrchestrationV2ThreadProjection | null | undefined;
}): boolean {
  return input.projection != null
    ? threadSupportsProviderHandoff(input.projection)
    : !threadShellHasStarted(input.thread);
}
