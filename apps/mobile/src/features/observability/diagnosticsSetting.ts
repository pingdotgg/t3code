// Start off until the saved crash-report preference loads.
let sending = false;

export const diagnosticsSendingEnabled = () => sending;
export function setDiagnosticsSending(enabled: boolean): void {
  sending = enabled;
}
