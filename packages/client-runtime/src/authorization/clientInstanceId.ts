// Clients present a stable per-install instance id when exchanging bootstrap
// credentials, letting the server collapse repeated bootstraps (app relaunches,
// window reloads) onto one authorized-client session instead of accumulating a
// row per launch.

export const CLIENT_INSTANCE_ID_STORAGE_KEY = "t3.clientInstanceId";

export function readOrCreateClientInstanceId(input: {
  readonly read: (key: string) => string | null | undefined;
  readonly write: (key: string, value: string) => void;
  readonly createId: () => string;
}): string {
  const stored = input.read(CLIENT_INSTANCE_ID_STORAGE_KEY);
  if (typeof stored === "string" && stored.trim() !== "") {
    return stored;
  }
  const created = input.createId();
  input.write(CLIENT_INSTANCE_ID_STORAGE_KEY, created);
  return created;
}
