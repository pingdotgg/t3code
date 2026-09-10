import {
  getMediaLibraryPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
} from "expo-image-picker";

/** Called only when the user enables the shortcut in Settings. */
export async function requestRecentPhotosAccess() {
  const access = await getMediaLibraryPermissionsAsync();
  return !access.granted && access.canAskAgain ? requestMediaLibraryPermissionsAsync() : access;
}

/** Only the newest permission operation may update the switch or stored preference. */
export function createRecentPhotosAccessOperations() {
  let version = 0;
  return {
    invalidate() {
      version += 1;
    },
    async run(
      read: typeof getMediaLibraryPermissionsAsync,
      apply: (access: Awaited<ReturnType<typeof getMediaLibraryPermissionsAsync>>) => void,
      onError: () => void,
    ) {
      const current = ++version;
      try {
        const access = await read();
        if (current === version) apply(access);
      } catch {
        if (current === version) onError();
      }
    },
  };
}
