// Free of imports: `observe.ts` loads ahead of the rest of the app and sets this.
let sending: boolean | null = null;

/** The "Send crash reports" setting, which relay traces follow as well. */
export function setDiagnosticsSending(enabled: boolean): void {
  sending = enabled;
}

/** False until the saved setting has loaded, so nothing is sent ahead of an opt-out. */
export function diagnosticsSendingEnabled(): boolean {
  return sending === true;
}
