const REPLAY_WORKSPACE_PLACEHOLDER = "<workspace>";
const REPLAY_HOME = "/home/replay-user";
const REPLAY_CHECKOUT = "/home/replay-user/t3code";
const REPLAY_HOSTNAME = "replay-host";
const REPLAY_VALUES_BY_KEY: Readonly<Record<string, string>> = {
  installationId: "00000000-0000-4000-8000-000000000000",
  planType: "unknown",
};

interface CodexReplayRecordingMachine {
  readonly home: string;
  readonly hostname: string;
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
