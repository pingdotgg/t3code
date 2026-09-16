/**
 * The Expo dev client launches the app via
 * <scheme>://expo-development-client/?url=<packager> — that URL addresses
 * the launcher, not app navigation. Without this filter it falls through
 * to the NotFound wildcard route on every dev launch.
 * expo-sharing uses a private lifecycle URL only to wake the app. The
 * persisted share inbox in App.tsx owns navigation once the payload is durable.
 * A scheme-only URL, as sent by iOS dictation keyboards returning to the app,
 * only wakes the app and must not reset navigation to Home.
 */
export function shouldHandleAppLink(url: string): boolean {
  return (
    !url.includes("expo-development-client") &&
    !url.includes("://expo-sharing") &&
    !/^t3code(-dev|-preview)?:\/*$/.test(url)
  );
}
