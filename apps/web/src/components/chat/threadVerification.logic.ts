import type { OrchestrationV2RunStatus, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

const VERIFICATION_REQUEST_PREFIX = "## Herdr verification\n";

export interface VerificationOptions {
  tests: boolean;
  browser: boolean;
  recording: boolean;
}

export function buildVerificationRequest(options: VerificationOptions): string {
  const checks = [
    options.tests
      ? "Run relevant existing tests and static checks scoped to the current changes."
      : "Do not run command-line tests or static checks.",
    options.browser
      ? "Check the changed user flows in the available browser. Capture only important states and failures."
      : "Do not start browser checks or capture screenshots.",
    options.browser && options.recording
      ? "Record the browser checks if recording is available."
      : "Do not record videos.",
  ];
  return (
    VERIFICATION_REQUEST_PREFIX +
    [
      "Verify the current changes in this thread. Preserve the implementation; report issues instead of fixing them.",
      ...checks,
      "Use one agent. Do not delegate. End with a concise report in my language: commands, exit codes, outcomes, coverage and anything not checked. Include Markdown links to any screenshots or recordings. Never call an unchecked flow passed.",
    ].join("\n")
  );
}

type Projection = Pick<OrchestrationV2ThreadProjection, "turnItems" | "runs">;
export type VerificationCommandStatus =
  | "passed"
  | "failed"
  | "running"
  | "interrupted"
  | "unconfirmed";

export function verificationCommandStatus(item: {
  status: string;
  exitCode?: number | undefined;
  outputIndicatesFailure?: boolean | undefined;
}): VerificationCommandStatus {
  if (
    (item.exitCode !== undefined && item.exitCode !== 0) ||
    item.outputIndicatesFailure ||
    item.status === "failed"
  )
    return "failed";
  if (["cancelled", "interrupted"].includes(item.status)) return "interrupted";
  if (item.status === "completed") return item.exitCode === 0 ? "passed" : "unconfirmed";
  return "running";
}

export function selectVerificationReport(projection: Projection | null) {
  if (!projection) return null;
  const request = projection.turnItems.findLast(
    (item) => item.type === "user_message" && item.text.startsWith(VERIFICATION_REQUEST_PREFIX),
  );
  if (!request || request.type !== "user_message") return null;
  const items =
    request.runId === null
      ? []
      : projection.turnItems.filter(
          (item) => item.runId === request.runId && item.ordinal > request.ordinal,
        );
  const commands = items
    .filter((item) => item.type === "command_execution")
    .map((item) => ({
      id: item.id,
      command: item.input,
      output: item.output ?? null,
      status: verificationCommandStatus(item),
      exitCode: item.exitCode ?? null,
    }));
  const messages = items.filter((item) => item.type === "assistant_message");
  const answer =
    messages.findLast((item) => item.phase === "final_answer") ?? messages.at(-1) ?? null;
  const run = projection.runs.find((run) => run.id === request.runId);
  const runStatus: OrchestrationV2RunStatus | null = run?.status ?? null;
  return { requestId: request.id, runId: request.runId, commands, answer, runStatus };
}
