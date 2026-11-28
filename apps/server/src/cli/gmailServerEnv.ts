/** Older launchers can still export a Gmail secret. Never forward it to provider CLIs. */
export function discardLegacyGmailEnvironment(env: NodeJS.ProcessEnv): void {
  delete env.HYAKKI_GMAIL_CLIENT_SECRET;
  delete env.HYAKKI_GMAIL_CLIENT_ID;
  delete env.HYAKKI_GMAIL_DESKTOP_CLIENT_ID;
}
