import type { ElectronicsCircuitModel, ElectronicsTracePathResult } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  RouteIcon,
  XCircleIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface PathTracerPanelProps {
  readonly model: ElectronicsCircuitModel;
  readonly fromValue: string;
  readonly toValue: string;
  readonly traversePassives: boolean;
  readonly running: boolean;
  readonly result: ElectronicsTracePathResult | null;
  readonly onChangeFrom: (value: string) => void;
  readonly onChangeTo: (value: string) => void;
  readonly onChangeTraversePassives: (value: boolean) => void;
  readonly onRunTrace: () => void;
  readonly onHighlightOnCanvas: (net: string | null, ref: string | null) => void;
}

function formatOhms(ohms: number, directLabel: string): string {
  if (ohms === 0) return directLabel;
  if (ohms >= 1_000_000) return `${(ohms / 1_000_000).toFixed(2)} MΩ`;
  if (ohms >= 1_000) return `${(ohms / 1_000).toFixed(2)} kΩ`;
  return `${ohms.toFixed(1)} Ω`;
}

export function PathTracerPanel(props: PathTracerPanelProps) {
  const {
    model,
    fromValue,
    toValue,
    traversePassives,
    running,
    result,
    onChangeFrom,
    onChangeTo,
    onChangeTraversePassives,
    onRunTrace,
    onHighlightOnCanvas,
  } = props;
  const gt = useGT();

  const endpointSuggestions: string[] = [];
  for (const net of model.nets) endpointSuggestions.push(net.name);
  for (const comp of model.components) {
    if (comp.kind === "power_symbol") continue;
    endpointSuggestions.push(comp.ref);
    for (const pin of comp.pins) {
      endpointSuggestions.push(`${comp.ref}.${pin.number}`);
      if (pin.name && pin.name !== pin.number) {
        endpointSuggestions.push(`${comp.ref}.${pin.name}`);
      }
    }
  }
  const uniqueSuggestions = Array.from(new Set(endpointSuggestions)).slice(0, 180);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs">
      <div className="rounded-lg border border-border bg-card/60 p-3">
        <div className="mb-2 flex items-center gap-1.5 font-medium text-foreground">
          <RouteIcon className="size-3.5 text-primary" />
          <T>Circuit Path Validator</T>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              <T>From (pin, component, or net)</T>
            </span>
            <Input
              size="sm"
              list="t3-electronics-endpoints"
              value={fromValue}
              onChange={(e) => onChangeFrom(e.target.value)}
              placeholder={gt("e.g. U1.VOUT or +5V")}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              <T>To (optional target)</T>
            </span>
            <Input
              size="sm"
              list="t3-electronics-endpoints"
              value={toValue}
              onChange={(e) => onChangeTo(e.target.value)}
              placeholder={gt("e.g. R2.1 or VSENSE")}
            />
          </label>
        </div>
        <datalist id="t3-electronics-endpoints">
          {uniqueSuggestions.map((opt) => (
            <option key={opt} value={opt} />
          ))}
        </datalist>

        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-2xs text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={traversePassives}
              onChange={(e) => onChangeTraversePassives(e.target.checked)}
              className="accent-primary"
            />
            <T>Traverse series passives (resistors, inductors, fuses, diodes)</T>
          </label>
          <Button
            size="xs"
            disabled={running || fromValue.trim().length === 0}
            onClick={onRunTrace}
          >
            {running ? <T>Tracing…</T> : <T>Validate Path</T>}
          </Button>
        </div>
      </div>

      {result && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card/50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-medium">
              {result.connected ? (
                <>
                  <CheckCircle2Icon className="size-4 text-success" />
                  <span className="text-success">
                    <T>Path Connected</T>
                  </span>
                </>
              ) : (
                <>
                  <XCircleIcon className="size-4 text-destructive" />
                  <span className="text-destructive">
                    <T>No Path Found</T>
                  </span>
                </>
              )}
            </div>
            {result.estimatedResistanceOhms !== undefined && (
              <span className="rounded bg-muted px-2 py-0.5 font-mono text-2xs text-foreground">
                {gt("Series R ≈ {value}", {
                  value: formatOhms(result.estimatedResistanceOhms, gt("0 Ω (direct wire)")),
                })}
              </span>
            )}
          </div>

          {result.hops.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-background/70 p-2">
              {result.hops.map((hop, pos) => (
                <div
                  key={`${hop.kind}:${hop.name}:${hop.fromPin ?? ""}:${hop.toPin ?? ""}`}
                  className="flex items-center gap-1.5"
                >
                  {pos > 0 && <ArrowRightIcon className="size-3 text-muted-foreground" />}
                  <button
                    type="button"
                    onClick={() =>
                      onHighlightOnCanvas(
                        hop.kind === "net" ? hop.name : null,
                        hop.kind === "component" ? hop.name : null,
                      )
                    }
                    className={
                      hop.kind === "net"
                        ? "rounded bg-primary/15 px-2 py-0.5 font-mono text-2xs font-medium text-primary hover:bg-primary/25"
                        : "rounded border border-warning/40 bg-warning/10 px-2 py-0.5 font-mono text-2xs text-warning hover:bg-warning/20"
                    }
                  >
                    {hop.name}
                    {hop.value ? ` (${hop.value})` : ""}
                  </button>
                </div>
              ))}
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="flex flex-col gap-1">
              {result.warnings.map((w) => (
                <div
                  key={w}
                  className="flex items-start gap-1.5 rounded bg-warning/10 px-2 py-1.5 text-2xs text-warning"
                >
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
