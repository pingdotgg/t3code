import { getClerkInstance } from "@clerk/expo";

const ADOPTION_DEADLINE_MS = 8_000;

let pendingAdoption: Promise<void> | null = null;

// Native Clerk can hold a session the JS client never saw; the native AuthView then only fails
// with `session_exists`. The JS token cache reads the native-owned device token, so the reloaded
// client is the native one. Mirrors @clerk/expo's unexported native client sync `pull()`.
export function adoptNativeClerkSession(): Promise<void> {
  // One refresh at a time: a reopened screen must not sign in while an older reload can still land.
  pendingAdoption ??= new Promise<void>((resolve, reject) => {
    // A stalled reload must not hold sign-in back; once past the deadline its result is ignored.
    let isStale = false;
    const deadline = setTimeout(() => {
      isStale = true;
      resolve();
    }, ADOPTION_DEADLINE_MS);
    adopt(() => isStale)
      .then(resolve, reject)
      .finally(() => clearTimeout(deadline));
  }).finally(() => {
    pendingAdoption = null;
  });
  return pendingAdoption;
}

async function adopt(isStale: () => boolean): Promise<void> {
  const clerk = getClerkInstance();
  const client = await clerk.client?.reload();
  if (!client || isStale()) return;
  clerk.updateClient(client);
  const sessions = client.signedInSessions;
  const session = sessions.find(({ id }) => id === client.lastActiveSessionId) ?? sessions[0];
  if (session && clerk.session?.id !== session.id) await clerk.setActive({ session });
}
