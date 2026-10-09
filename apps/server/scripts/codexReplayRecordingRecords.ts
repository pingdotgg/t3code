const REPLAY_WORKSPACE_PLACEHOLDER = "<workspace>";
const REPLAY_HOME = "/home/replay-user";
const REPLAY_CHECKOUT = "/home/replay-user/t3code";
const REPLAY_HOSTNAME = "replay-host";
/** Account- and install-scoped values Codex reports; the adapter reads none of them. */
const REPLAY_VALUES_BY_KEY: Readonly<Record<string, string>> = {
  installationId: "00000000-0000-4000-8000-000000000000",
  planType: "unknown",
};

interface CodexReplayRecordingMachine {
  readonly home: string;
  readonly hostname: string;
  /** Root of the checkout the recorder runs from; it names the local worktree layout. */
  readonly checkout: string;
}

function withWorkspacePlaceholder(value: unknown, workspace: string): unknown {
  if (value === workspace) {
    return REPLAY_WORKSPACE_PLACEHOLDER;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => withWorkspacePlaceholder(entry, workspace));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, withWorkspacePlaceholder(entry, workspace)]),
  );
}

function withoutMachineIdentity(
  value: unknown,
  machine: CodexReplayRecordingMachine,
  key?: string,
): unknown {
  if (typeof value === "string") {
    const replacement = key === undefined ? undefined : REPLAY_VALUES_BY_KEY[key];
    if (replacement !== undefined) return replacement;
    return value === machine.hostname
      ? REPLAY_HOSTNAME
      : value.replaceAll(machine.checkout, REPLAY_CHECKOUT).replaceAll(machine.home, REPLAY_HOME);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => withoutMachineIdentity(entry, machine));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      withoutMachineIdentity(entry, machine, entryKey),
    ]),
  );
}

/**
 * Codex supports multiple provider threads in one app-server session, so native
 * fork recording keeps the request ids emitted by that single client. Outbound
 * frames name the recording cwd `<workspace>`, which replay swaps for its own
 * checkpoint workspace. With `machine`, every frame also swaps the checkout
 * path, home directory, hostname, installation id and plan type for neutral
 * values so fixtures carry no local identity; the adapter reads none of them.
 */
export function codexReplayRecordingOutputRecords(
  records: ReadonlyArray<Record<string, unknown>>,
  options: {
    readonly workspace: string;
    readonly machine?: CodexReplayRecordingMachine;
  },
): ReadonlyArray<Record<string, unknown>> {
  return records.map((record) => {
    const named =
      record.type === "expect_outbound"
        ? { ...record, frame: withWorkspacePlaceholder(record.frame, options.workspace) }
        : record;
    return options.machine === undefined || !("frame" in named)
      ? named
      : { ...named, frame: withoutMachineIdentity(named.frame, options.machine) };
  });
}
