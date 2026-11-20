let pendingRequestId: string | null = null;

export function requestNewTaskDictation(requestId: string): void {
  pendingRequestId = requestId;
}

export function takeNewTaskDictation(requestId: string | undefined): boolean {
  if (requestId === undefined || requestId !== pendingRequestId) return false;
  pendingRequestId = null;
  return true;
}
