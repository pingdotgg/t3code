import { CommandId, type PipelineId, type ProjectId } from "@t3tools/contracts";

/** One start request's idempotency key, tied to what the request carries. */
export interface PipelineStartAttempt {
  readonly fingerprint: string;
  readonly commandId: CommandId;
}

/**
 * A failed start keeps the draft, so a retry must reuse the command id (the server then returns
 * the run the first attempt created) until the user changes anything the request carries.
 * `workspace` is the user's workspace selection, in any JSON-serialisable shape.
 */
export function nextPipelineStartAttempt(
  previous: PipelineStartAttempt | null,
  request: {
    readonly pipelineId: PipelineId;
    readonly projectId: ProjectId;
    readonly input: string;
    readonly workspace: unknown;
  },
  newId: () => string,
): PipelineStartAttempt {
  const fingerprint = JSON.stringify([
    request.pipelineId,
    request.projectId,
    request.input,
    request.workspace,
  ]);
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, commandId: CommandId.make(newId()) };
}
