import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

/** Whether a terminal-close confirmation is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

interface TerminalCloseTarget {
  readonly label: string;
  readonly hasRunningSubprocess?: boolean | undefined;
}

interface InspectedTerminalActivity {
  readonly terminalId: string;
  readonly hasRunningSubprocess: boolean | null;
}

interface ConfirmInspectedTerminalCloseOptions {
  readonly terminalIds: readonly [string, ...string[]];
  readonly labelFor: (terminalId: string) => string;
  readonly inspect: (
    terminalIds: readonly [string, ...string[]],
  ) => Promise<ReadonlyArray<InspectedTerminalActivity> | undefined>;
}

/**
 * Confirmation for individual terminal close actions: drawer buttons, panel
 * buttons, the `terminal.close` keybinding, and closing a terminal surface from
 * the tab strip. Known idle terminals close directly; missing activity state is
 * treated conservatively and still prompts. Auto-exit cleanup and bulk tab
 * closes skip this path and close directly.
 */
export async function confirmTerminalClose(
  targets: readonly [TerminalCloseTarget, ...TerminalCloseTarget[]],
): Promise<boolean> {
  if (targets.every((target) => target.hasRunningSubprocess === false)) {
    return true;
  }
  const localApi = readLocalApi();
  if (!localApi) return true;
  const labels = targets.map((target) => target.label);
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            `Close terminal "${labels[0]}"?`,
            "This stops the running process and clears its history.",
          ].join("\n")
        : [
            `Close ${labels.length} terminals?`,
            `This stops their running processes and clears their histories: ${labels
              .map((label) => `"${label}"`)
              .join(", ")}.`,
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}

/** Refresh activity immediately before deciding whether a close is destructive. */
export async function confirmInspectedTerminalClose(
  options: ConfirmInspectedTerminalCloseOptions,
): Promise<boolean> {
  const inspected = await options.inspect(options.terminalIds).catch(() => undefined);
  const activityByTerminalId = new Map(
    inspected?.map((terminal) => [terminal.terminalId, terminal.hasRunningSubprocess] as const) ??
      [],
  );
  const targetFor = (terminalId: string): TerminalCloseTarget => ({
    label: options.labelFor(terminalId),
    hasRunningSubprocess: activityByTerminalId.get(terminalId) ?? undefined,
  });
  const [firstTerminalId, ...otherTerminalIds] = options.terminalIds;
  return confirmTerminalClose([targetFor(firstTerminalId), ...otherTerminalIds.map(targetFor)]);
}
