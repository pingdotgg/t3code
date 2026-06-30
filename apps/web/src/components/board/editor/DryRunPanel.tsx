import type {
  WorkflowDefinitionEncoded,
  WorkflowDryRunResult,
  WorkflowDryRunScenario,
} from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { describeDryRunEnd, describeDryRunHop } from "~/workflow/dryRunFormat";

const SCENARIOS: ReadonlyArray<{ readonly value: WorkflowDryRunScenario; readonly label: string }> =
  [
    { value: "success", label: "All steps succeed" },
    { value: "failure", label: "All steps fail" },
    { value: "blocked", label: "All steps block" },
  ];

/**
 * Simulates a hypothetical ticket through the definition currently in the
 * editor (saved or not) and explains every hop. Catches dead ends and
 * unbounded loops before any agent burns tokens on them.
 */
export function DryRunPanel({
  definition,
  onDryRun,
  onClose,
}: {
  readonly definition: WorkflowDefinitionEncoded;
  readonly onDryRun: (input: {
    readonly startLane: string;
    readonly scenario: WorkflowDryRunScenario;
  }) => Promise<WorkflowDryRunResult>;
  readonly onClose: () => void;
}) {
  const lanes = definition.lanes.map((lane) => ({
    key: String(lane.key),
    name: lane.name,
  }));
  const [startLane, setStartLane] = useState(lanes[0]?.key ?? "");
  const [scenario, setScenario] = useState<WorkflowDryRunScenario>("success");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WorkflowDryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!lanes.some((lane) => lane.key === startLane)) {
      setStartLane(lanes[0]?.key ?? "");
    }
  }, [lanes, startLane]);

  const laneName = (key: string) => lanes.find((lane) => lane.key === key)?.name ?? key;

  const run = async () => {
    const requestId = ++requestRef.current;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const next = await onDryRun({ startLane, scenario });
      if (requestRef.current === requestId) {
        setResult(next);
      }
    } catch (cause) {
      if (requestRef.current === requestId) {
        setError(cause instanceof Error ? cause.message : "Dry run failed.");
      }
    } finally {
      if (requestRef.current === requestId) {
        setRunning(false);
      }
    }
  };

  return (
    <div className="border-b border-border bg-card/40 px-4 py-3" data-testid="dry-run-panel">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs font-medium text-foreground">
          Start lane
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={startLane}
            onChange={(event) => setStartLane(event.currentTarget.value)}
            aria-label="Dry run start lane"
          >
            {lanes.map((lane) => (
              <option key={lane.key} value={lane.key}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-foreground">
          Scenario
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={scenario}
            onChange={(event) => setScenario(event.currentTarget.value as WorkflowDryRunScenario)}
            aria-label="Dry run scenario"
          >
            {SCENARIOS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" disabled={running || startLane === ""} onClick={() => void run()}>
          <PlayIcon className="size-3.5" />
          {running ? "Simulating…" : "Simulate"}
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      {error !== null ? (
        <p className="mt-2 text-xs text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}
      {result !== null ? (
        <div className="mt-3 space-y-1.5" data-testid="dry-run-result">
          {result.hops.length === 0 ? (
            <p className="text-xs text-muted-foreground">No hops — the ticket stays put.</p>
          ) : (
            <ol className="space-y-1">
              {result.hops.map((hop, index) => (
                <li key={index} className="text-xs text-foreground">
                  <span className="mr-1.5 inline-block w-5 text-right text-muted-foreground">
                    {index + 1}.
                  </span>
                  {describeDryRunHop(hop, laneName)}
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs font-medium text-foreground" data-testid="dry-run-end">
            {describeDryRunEnd(result, laneName)}
          </p>
          {result.notes.map((note, index) => (
            <p key={index} className="text-[11px] text-warning">
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
