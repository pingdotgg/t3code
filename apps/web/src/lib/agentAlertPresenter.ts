import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface PresentedAgentAlert {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly body: string;
}

type PresentAgentAlert = (alert: PresentedAgentAlert) => void;

let present: PresentAgentAlert | null = null;

export function setAgentAlertPresenter(next: PresentAgentAlert | null): void {
  present = next;
}

export function emitAgentAlert(alert: PresentedAgentAlert): void {
  present?.(alert);
}
