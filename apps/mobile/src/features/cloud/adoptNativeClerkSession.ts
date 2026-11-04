import { getClerkInstance } from "@clerk/expo";

// Native Clerk can hold a session the JS client never saw; the native AuthView then only fails
// with `session_exists`. The JS token cache reads the native-owned device token, so the reloaded
// client is the native one. Mirrors @clerk/expo's unexported native client sync `pull()`.
export async function adoptNativeClerkSession(): Promise<void> {
  const clerk = getClerkInstance();
  const client = await clerk.client?.reload();
  if (!client) return;
  clerk.updateClient(client);
  const sessions = client.signedInSessions;
  const session = sessions.find(({ id }) => id === client.lastActiveSessionId) ?? sessions[0];
  if (session && clerk.session?.id !== session.id) await clerk.setActive({ session });
}
