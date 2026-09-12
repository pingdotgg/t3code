export function connectorLeaseCanBeRevoked(
  currentLeaseId: string | undefined,
  expectedLeaseId: string | undefined,
): boolean {
  return (
    currentLeaseId === undefined ||
    expectedLeaseId === undefined ||
    currentLeaseId === expectedLeaseId
  );
}

export interface ConnectorSessionIdentity {
  readonly leaseId: string;
  readonly sessionId: string;
}

export function connectorSessionIsCurrent(
  configuredLeaseId: string | undefined,
  activeSession: ConnectorSessionIdentity | undefined,
  attachedSession: ConnectorSessionIdentity,
): boolean {
  return (
    configuredLeaseId !== undefined &&
    attachedSession.leaseId === configuredLeaseId &&
    activeSession?.leaseId === attachedSession.leaseId &&
    activeSession.sessionId === attachedSession.sessionId
  );
}
