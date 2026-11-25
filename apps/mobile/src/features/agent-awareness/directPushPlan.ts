import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Which connected environments still need this device's token, and which records to drop because
 * their environment disconnected, so it registers again when it comes back.
 */
export function planDirectPushRegistration(input: {
  readonly token: string | null;
  readonly connected: ReadonlyArray<EnvironmentId>;
  readonly supportsDirectPush: (environmentId: EnvironmentId) => boolean;
  readonly registered: ReadonlyMap<EnvironmentId, string>;
}): {
  readonly register: ReadonlyArray<EnvironmentId>;
  readonly forget: ReadonlyArray<EnvironmentId>;
} {
  const connected = new Set(input.connected);
  const forget = [...input.registered.keys()].filter((id) => !connected.has(id));
  const token = input.token;
  const register =
    token === null
      ? []
      : input.connected.filter(
          (id) => input.supportsDirectPush(id) && input.registered.get(id) !== token,
        );
  return { register, forget };
}
