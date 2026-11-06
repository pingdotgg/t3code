import type { ConnectionDiagnosticsSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";

export function makeConnectionDiagnostics() {
  const milestones = new Set<ConnectionDiagnosticsSnapshot["milestones"][number]>();
  const counts = { rx: 0, tx: 0, closes: 0, errors: 0, binary: 0 };
  let firstFailure: ConnectionDiagnosticsSnapshot["firstFailure"];
  let closeCode: number | undefined;
  return {
    mark: (milestone: ConnectionDiagnosticsSnapshot["milestones"][number]) => {
      milestones.add(milestone);
    },
    count: (counter: keyof typeof counts) => {
      counts[counter] = Math.min(counts[counter] + 1, 1_000_000_000);
    },
    fail: (failure: NonNullable<ConnectionDiagnosticsSnapshot["firstFailure"]>) => {
      firstFailure ??= failure;
    },
    close: (code: number) => {
      if (Number.isInteger(code) && code >= 0 && code <= 65535) closeCode = code;
    },
    snapshot: (): ConnectionDiagnosticsSnapshot => ({
      milestones: [...milestones],
      ...counts,
      ...(firstFailure === undefined ? {} : { firstFailure }),
      ...(closeCode === undefined ? {} : { closeCode }),
    }),
  };
}

export class ConnectionDiagnostics extends Context.Reference<
  ReturnType<typeof makeConnectionDiagnostics> | undefined
>("@t3tools/client-runtime/connection/diagnostics", { defaultValue: () => undefined }) {}
