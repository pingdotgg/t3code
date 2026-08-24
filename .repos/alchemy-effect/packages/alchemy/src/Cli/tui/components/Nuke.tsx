/** @jsxImportSource react */
import { Box, render, Text } from "ink";
import { useEffect, useRef, useState, type JSX } from "react";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ScanEvent =
  | { kind: "start"; id: string }
  | { kind: "done"; id: string; count: number }
  | { kind: "error"; id: string; message: string };

export type DeleteEvent =
  | { kind: "pass"; pass: number }
  | { kind: "deleted"; id: string }
  | { kind: "failed"; id: string };

interface EventSource<E> {
  subscribe(listener: (event: E) => void): () => void;
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinner(intervalMs = 80): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % spinnerFrames.length),
      intervalMs,
    );
    return () => clearInterval(timer);
  }, [intervalMs]);
  return spinnerFrames[index]!;
}

const bar = (done: number, total: number, width = 24): string => {
  if (total <= 0) return "▱".repeat(width);
  const filled = Math.round((done / total) * width);
  return "▰".repeat(filled) + "▱".repeat(Math.max(0, width - filled));
};

// ---------------------------------------------------------------------------
// Scan phase
// ---------------------------------------------------------------------------

interface ScanState {
  scanned: number;
  toDelete: number;
  inFlight: string[];
}

/**
 * A single left-to-right progress bar tracking scanned vs. outstanding
 * providers, with a running tally of resources to delete. While scanning, the
 * providers still in flight are listed below the bar so a slow/hanging
 * provider near the end is immediately identifiable. Per-provider detail is
 * printed to the console once scanning completes.
 */
function ScanProgress(props: {
  total: number;
  source: EventSource<ScanEvent>;
}): JSX.Element {
  const { total, source } = props;
  const spinner = useSpinner();
  const [state, setState] = useState<ScanState>(() => ({
    scanned: 0,
    toDelete: 0,
    inFlight: [],
  }));

  useEffect(() => {
    return source.subscribe((event) =>
      setState((prev) => {
        const inFlight = new Set(prev.inFlight);
        if (event.kind === "start") {
          inFlight.add(event.id);
          return { ...prev, inFlight: [...inFlight] };
        }
        inFlight.delete(event.id);
        return {
          scanned: prev.scanned + 1,
          toDelete: prev.toDelete + (event.kind === "done" ? event.count : 0),
          inFlight: [...inFlight],
        };
      }),
    );
  }, [source]);

  const done = state.scanned >= total;
  const stragglers = state.inFlight.slice(0, 10);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={done ? "green" : "cyan"}>
          {bar(state.scanned, total, 32)}{" "}
        </Text>
        <Text bold>
          {state.scanned}/{total}
        </Text>
        <Text dimColor> providers</Text>
        <Text dimColor> · </Text>
        <Text bold color="yellowBright">
          {state.toDelete}
        </Text>
        <Text dimColor> to delete</Text>
      </Box>
      {!done && stragglers.length > 0 ? (
        <Box flexDirection="column">
          {stragglers.map((id) => (
            <Box key={id} flexDirection="row">
              <Text color="cyan">{spinner} </Text>
              <Text dimColor>scanning {id}</Text>
            </Box>
          ))}
          {state.inFlight.length > stragglers.length ? (
            <Text dimColor>
              {" "}
              …and {state.inFlight.length - stragglers.length} more
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export interface ScanUI {
  emit: (event: ScanEvent) => void;
  unmount: () => void;
}

export const renderScan = (total: number): ScanUI => {
  const listeners = new Set<(event: ScanEvent) => void>();
  const { unmount } = render(
    <ScanProgress
      total={total}
      source={{
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }}
    />,
  );
  return {
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    unmount,
  };
};

// ---------------------------------------------------------------------------
// Delete phase
// ---------------------------------------------------------------------------

interface TypeProgress {
  total: number;
  deleted: number;
  failed: number;
}

function DeleteProgress(props: {
  totals: { id: string; total: number }[];
  source: EventSource<DeleteEvent>;
}): JSX.Element {
  const { totals, source } = props;
  const spinner = useSpinner();
  const grandTotal = totals.reduce((a, b) => a + b.total, 0);
  const [pass, setPass] = useState(1);
  const [rows, setRows] = useState<Map<string, TypeProgress>>(
    () =>
      new Map(
        totals.map((t) => [t.id, { total: t.total, deleted: 0, failed: 0 }]),
      ),
  );

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    return source.subscribe((event) => {
      if (event.kind === "pass") {
        setPass(event.pass);
        // reset transient per-pass failure counters at the start of a pass
        setRows((prev) => {
          const next = new Map(prev);
          for (const [id, row] of next) next.set(id, { ...row, failed: 0 });
          return next;
        });
        return;
      }
      setRows((prev) => {
        const next = new Map(prev);
        const row = next.get(event.id);
        if (!row) return prev;
        if (event.kind === "deleted") {
          next.set(event.id, { ...row, deleted: row.deleted + 1 });
        } else {
          next.set(event.id, { ...row, failed: row.failed + 1 });
        }
        return next;
      });
    });
  }, [source]);

  const totalDeleted = [...rows.values()].reduce((a, b) => a + b.deleted, 0);
  const sorted = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="red">{bar(totalDeleted, grandTotal)} </Text>
        <Text bold>
          {totalDeleted}/{grandTotal}
        </Text>
        <Text dimColor> deleted</Text>
        <Text dimColor> · pass {pass}</Text>
      </Box>
      <Box flexDirection="column">
        {sorted.map(([id, row]) => {
          const remaining = row.total - row.deleted;
          const complete = remaining === 0;
          const icon = complete ? "✓" : spinner;
          const color = complete ? "green" : row.failed > 0 ? "yellow" : "red";
          return (
            <Box key={id} flexDirection="row">
              <Text color={color}>{icon} </Text>
              <Text>{id.padEnd(40)}</Text>
              <Text bold color={color}>
                {" "}
                {row.deleted}/{row.total}
              </Text>
              {row.failed > 0 ? (
                <Text color="redBright"> ({row.failed} failed)</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export interface DeleteUI {
  emit: (event: DeleteEvent) => void;
  unmount: () => void;
}

export const renderDelete = (
  totals: { id: string; total: number }[],
): DeleteUI => {
  const listeners = new Set<(event: DeleteEvent) => void>();
  const { unmount } = render(
    <DeleteProgress
      totals={totals}
      source={{
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }}
    />,
  );
  return {
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    unmount,
  };
};
