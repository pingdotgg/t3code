import type {
  ElectronicsCircuitModel,
  ElectronicsComponent,
  ElectronicsTracePathResult,
  ElectronicsValidationIssue,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CrosshairIcon, LayersIcon, Maximize2Icon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { type MouseEvent, type WheelEvent, useRef, useState } from "react";

import { Button } from "../ui/button";

export interface CircuitCanvasProps {
  readonly model: ElectronicsCircuitModel;
  readonly selectedNet: string | null;
  readonly selectedRef: string | null;
  readonly activeTrace: ElectronicsTracePathResult | null;
  readonly validationIssues: ReadonlyArray<ElectronicsValidationIssue>;
  readonly onSelectNet: (net: string | null) => void;
  readonly onSelectRef: (ref: string | null) => void;
  readonly onStartTraceFrom?: (endpoint: string) => void;
}

function layerColor(layer: string | undefined, isPcb: boolean): string {
  if (!isPcb) return "var(--chart-2, #10b981)";
  if (layer === "F.Cu") return "var(--destructive, #ef4444)";
  if (layer === "B.Cu") return "var(--info, #3b82f6)";
  if (layer === "Edge.Cuts") return "var(--warning, #eab308)";
  return "var(--chart-3, #a855f7)";
}

function componentBodySize(comp: ElectronicsComponent, isPcb: boolean): { w: number; h: number } {
  if (isPcb) {
    if (comp.pins.length >= 2) {
      let minX = comp.x ?? 0;
      let maxX = comp.x ?? 0;
      let minY = comp.y ?? 0;
      let maxY = comp.y ?? 0;
      for (const p of comp.pins) {
        if (p.x !== undefined) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
        }
        if (p.y !== undefined) {
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        }
      }
      return {
        w: Math.max(2.4, maxX - minX + 1.4),
        h: Math.max(1.6, maxY - minY + 1.2),
      };
    }
    return { w: 3.2, h: 2.0 };
  }
  if (comp.kind === "ic") return { w: 12, h: Math.max(10, comp.pins.length * 2.5) };
  if (comp.kind === "power_symbol") return { w: 3.6, h: 3.6 };
  if (comp.kind === "power_source") return { w: 9, h: 9 };
  return { w: 9, h: 6 };
}

export function CircuitCanvas(props: CircuitCanvasProps) {
  const {
    model,
    selectedNet,
    selectedRef,
    activeTrace,
    validationIssues,
    onSelectNet,
    onSelectRef,
    onStartTraceFrom,
  } = props;
  const gt = useGT();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const isPcb = model.format === "kicad_pcb" || model.boardOutline.length > 0;

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<ReadonlySet<string>>(() => new Set());
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [lastFilePath, setLastFilePath] = useState(model.filePath);
  if (model.filePath !== lastFilePath) {
    setLastFilePath(model.filePath);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHiddenLayers(new Set());
    setShowLayerMenu(false);
  }

  const bounds = model.bounds;
  const baseWidth = Math.max(10, bounds.maxX - bounds.minX);
  const baseHeight = Math.max(10, bounds.maxY - bounds.minY);
  const viewW = baseWidth / zoom;
  const viewH = baseHeight / zoom;
  const viewX = bounds.minX + (baseWidth - viewW) / 2 - pan.x;
  const viewY = bounds.minY + (baseHeight - viewH) / 2 - pan.y;

  const traceNets = new Set(activeTrace?.highlightedNets ?? []);
  const traceComps = new Set(activeTrace?.highlightedComponents ?? []);

  const layerSet = new Set<string>();
  for (const l of model.layers) layerSet.add(l);
  for (const w of model.wires) {
    if (w.layer) layerSet.add(w.layer);
  }
  const availableLayers = Array.from(layerSet);

  const toggleLayer = (layer: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
    setZoom((prev) => Math.max(0.35, Math.min(12, Number((prev * factor).toFixed(3)))));
  };

  const handleMouseDown = (event: MouseEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    setDragging({
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    });
  };

  const handleMouseMove = (event: MouseEvent<SVGSVGElement>) => {
    if (!dragging || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dx = ((event.clientX - dragging.startX) / rect.width) * viewW;
    const dy = ((event.clientY - dragging.startY) / rect.height) * viewH;
    setPan({ x: dragging.originX + dx, y: dragging.originY + dy });
  };

  const handleMouseUp = () => {
    if (dragging) setDragging(null);
  };

  const selectedComponent = (() => {
    if (!selectedRef) return null;
    const units = model.components.filter((c) => c.ref === selectedRef);
    if (units.length === 0) return null;
    if (units.length === 1) return units[0]!;
    const dedupedPins: ElectronicsCircuitModel["components"][number]["pins"][number][] = [];
    const seenPinNumbers = new Set<string>();
    for (const unit of units) {
      for (const pin of unit.pins) {
        if (seenPinNumbers.has(pin.number)) continue;
        seenPinNumbers.add(pin.number);
        dedupedPins.push(pin);
      }
    }
    return {
      ...units[0]!,
      pins: dedupedPins,
    };
  })();
  const selectedNetObj = selectedNet
    ? (model.nets.find((n) => n.name === selectedNet) ?? null)
    : null;

  const unitScale = Math.max(baseWidth, baseHeight) / 100;
  const strokeUnit = Math.max(0.18, unitScale * 0.45);
  const fontUnit = Math.max(1.1, unitScale * 2.3);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-muted/20">
        <div className="pointer-events-auto absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-border/70 bg-popover/90 p-1 shadow-xs backdrop-blur-xs">
          {isPcb && availableLayers.length > 0 && (
            <Button
              size="xs"
              variant={showLayerMenu ? "secondary" : "ghost"}
              onClick={() => setShowLayerMenu((v) => !v)}
              aria-label={gt("Toggle PCB layers")}
            >
              <LayersIcon className="size-3.5" />
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setZoom((z) => Math.min(12, Number((z * 1.25).toFixed(3))))}
            aria-label={gt("Zoom in")}
          >
            <ZoomInIcon className="size-3.5" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setZoom((z) => Math.max(0.35, Number((z / 1.25).toFixed(3))))}
            aria-label={gt("Zoom out")}
          >
            <ZoomOutIcon className="size-3.5" />
          </Button>
          <Button size="xs" variant="ghost" onClick={resetView} aria-label={gt("Fit view")}>
            <Maximize2Icon className="size-3.5" />
          </Button>
        </div>

        {isPcb && showLayerMenu && (
          <div className="absolute top-10 right-2 z-20 flex flex-col gap-1 rounded-md border border-border bg-popover p-2 text-xs shadow-md">
            <div className="font-medium text-muted-foreground">
              <T>Layers</T>
            </div>
            {availableLayers.map((layer) => {
              const visible = !hiddenLayers.has(layer);
              return (
                <label key={layer} className="flex cursor-pointer items-center gap-2 select-none">
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => toggleLayer(layer)}
                    className="accent-primary"
                  />
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: layerColor(layer, true) }}
                  />
                  <span className="font-mono text-2xs">{layer}</span>
                </label>
              );
            })}
          </div>
        )}

        {(selectedNet || activeTrace) && (
          <div className="absolute top-2 left-2 z-10 flex flex-wrap items-center gap-1.5 rounded-md border border-border/70 bg-popover/90 px-2 py-1 text-2xs shadow-xs backdrop-blur-xs">
            {selectedNet && (
              <span className="flex items-center gap-1 font-mono text-primary">
                <CrosshairIcon className="size-3" />
                {selectedNet}
                <button
                  type="button"
                  className="ml-1 text-muted-foreground hover:text-foreground"
                  onClick={() => onSelectNet(null)}
                  aria-label={gt("Clear selected net")}
                >
                  ×
                </button>
              </span>
            )}
            {activeTrace && (
              <span className="font-mono text-warning">
                {activeTrace.from}
                {activeTrace.to ? ` → ${activeTrace.to}` : ""}
              </span>
            )}
          </div>
        )}

        <svg
          ref={svgRef}
          className="size-full cursor-grab select-none active:cursor-grabbing"
          viewBox={`${viewX} ${viewY} ${viewW} ${viewH}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          aria-label={gt("Interactive circuit canvas")}
        >
          <defs>
            <pattern
              id="t3-electronics-grid"
              width={Math.max(2, unitScale * 8)}
              height={Math.max(2, unitScale * 8)}
              patternUnits="userSpaceOnUse"
            >
              <circle
                cx={Math.max(1, unitScale * 4)}
                cy={Math.max(1, unitScale * 4)}
                r={Math.max(0.12, unitScale * 0.25)}
                fill="currentColor"
                opacity="0.14"
              />
            </pattern>
          </defs>
          <rect
            x={viewX - viewW}
            y={viewY - viewH}
            width={viewW * 3}
            height={viewH * 3}
            fill="url(#t3-electronics-grid)"
            onClick={() => {
              onSelectNet(null);
              onSelectRef(null);
            }}
          />

          {!hiddenLayers.has("Edge.Cuts") &&
            model.boardOutline.map((seg) => (
              <line
                key={`edge:${seg.x1}:${seg.y1}:${seg.x2}:${seg.y2}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                stroke="var(--warning, #eab308)"
                strokeWidth={strokeUnit * 1.1}
                strokeLinecap="round"
              />
            ))}

          {model.wires.map((seg) => {
            if (seg.layer && hiddenLayers.has(seg.layer)) return null;
            const isSelected = Boolean(seg.net && seg.net === selectedNet);
            const isTraced = Boolean(seg.net && traceNets.has(seg.net));
            const baseStroke = seg.width ? Math.max(strokeUnit * 0.7, seg.width) : strokeUnit;
            const color = isTraced
              ? "var(--warning, #f59e0b)"
              : isSelected
                ? "var(--primary, #38bdf8)"
                : layerColor(seg.layer, isPcb);
            return (
              <g
                key={`w:${seg.layer ?? ""}:${seg.net ?? ""}:${seg.x1}:${seg.y1}:${seg.x2}:${seg.y2}`}
              >
                {(isSelected || isTraced) && (
                  <line
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    stroke={color}
                    strokeWidth={baseStroke * 2.8}
                    strokeLinecap="round"
                    opacity={0.28}
                  />
                )}
                <line
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke={color}
                  strokeWidth={isSelected || isTraced ? baseStroke * 1.6 : baseStroke}
                  strokeLinecap="round"
                  strokeDasharray={isTraced ? `${strokeUnit * 3} ${strokeUnit * 1.5}` : undefined}
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (seg.net) onSelectNet(seg.net);
                  }}
                />
              </g>
            );
          })}

          {model.vias.map((via) => {
            const highlighted = Boolean(
              (via.net && via.net === selectedNet) || (via.net && traceNets.has(via.net)),
            );
            return (
              <g
                key={`via:${via.x}:${via.y}:${via.net ?? ""}`}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  if (via.net) onSelectNet(via.net);
                }}
              >
                <circle
                  cx={via.x}
                  cy={via.y}
                  r={Math.max(strokeUnit * 1.2, via.size / 2)}
                  fill={highlighted ? "var(--warning, #f59e0b)" : "var(--muted-foreground)"}
                  opacity={0.85}
                />
                <circle
                  cx={via.x}
                  cy={via.y}
                  r={Math.max(strokeUnit * 0.5, (via.drill ?? via.size * 0.45) / 2)}
                  fill="var(--background)"
                />
              </g>
            );
          })}

          {model.junctions.map((pt) => (
            <circle
              key={`j:${pt.x}:${pt.y}`}
              cx={pt.x}
              cy={pt.y}
              r={strokeUnit * 1.4}
              fill="var(--chart-2, #10b981)"
            />
          ))}

          {model.noConnects.map((pt) => (
            <g
              key={`nc:${pt.x}:${pt.y}`}
              stroke="var(--muted-foreground)"
              strokeWidth={strokeUnit * 0.7}
            >
              <line
                x1={pt.x - strokeUnit * 1.8}
                y1={pt.y - strokeUnit * 1.8}
                x2={pt.x + strokeUnit * 1.8}
                y2={pt.y + strokeUnit * 1.8}
              />
              <line
                x1={pt.x - strokeUnit * 1.8}
                y1={pt.y + strokeUnit * 1.8}
                x2={pt.x + strokeUnit * 1.8}
                y2={pt.y - strokeUnit * 1.8}
              />
            </g>
          ))}

          {model.components.map((comp) => {
            if (comp.x === undefined || comp.y === undefined) return null;
            const { w, h } = componentBodySize(comp, isPcb);
            const isSelected = comp.ref === selectedRef;
            const isTraced = traceComps.has(comp.ref);
            const touchesSelectedNet =
              selectedNet !== null && comp.pins.some((p) => p.net === selectedNet);
            const borderColor = isTraced
              ? "var(--warning, #f59e0b)"
              : isSelected
                ? "var(--primary, #38bdf8)"
                : touchesSelectedNet
                  ? "var(--chart-2, #10b981)"
                  : comp.kind === "power_symbol"
                    ? "var(--destructive, #ef4444)"
                    : "var(--foreground)";

            return (
              <g
                key={`comp:${comp.ref}:${comp.x}:${comp.y}`}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectRef(comp.ref);
                }}
              >
                {comp.kind === "power_symbol" ? (
                  <polygon
                    points={`${comp.x},${comp.y - h * 0.6} ${comp.x - w * 0.5},${comp.y + h * 0.4} ${comp.x + w * 0.5},${comp.y + h * 0.4}`}
                    fill="var(--card)"
                    stroke={borderColor}
                    strokeWidth={strokeUnit * 0.9}
                  />
                ) : (
                  <rect
                    x={comp.x - w / 2}
                    y={comp.y - h / 2}
                    width={w}
                    height={h}
                    rx={strokeUnit * 1.1}
                    fill={
                      isTraced ? "var(--warning-surface, rgba(245, 158, 11, 0.14))" : "var(--card)"
                    }
                    fillOpacity={isPcb ? 0.65 : 0.92}
                    stroke={borderColor}
                    strokeWidth={isSelected || isTraced ? strokeUnit * 1.5 : strokeUnit * 0.9}
                  />
                )}

                {comp.pins.map((pin) => {
                  if (pin.x === undefined || pin.y === undefined) return null;
                  const pinHighlighted =
                    (pin.net && pin.net === selectedNet) || (pin.net && traceNets.has(pin.net));
                  return (
                    <g
                      key={`pin:${comp.ref}:${pin.number}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectRef(comp.ref);
                        if (pin.net) onSelectNet(pin.net);
                      }}
                    >
                      {!isPcb && (
                        <line
                          x1={comp.x!}
                          y1={comp.y!}
                          x2={pin.x}
                          y2={pin.y}
                          stroke={
                            pinHighlighted ? "var(--warning, #f59e0b)" : "var(--muted-foreground)"
                          }
                          strokeWidth={strokeUnit * 0.55}
                          opacity={0.45}
                        />
                      )}
                      <circle
                        cx={pin.x}
                        cy={pin.y}
                        r={isPcb ? Math.max(strokeUnit * 1.1, 0.42) : strokeUnit * 1.15}
                        fill={
                          pinHighlighted
                            ? "var(--warning, #f59e0b)"
                            : !pin.net
                              ? "var(--destructive, #ef4444)"
                              : "var(--chart-1, #6366f1)"
                        }
                        stroke="var(--background)"
                        strokeWidth={strokeUnit * 0.3}
                      />
                    </g>
                  );
                })}

                <text
                  x={comp.x}
                  y={comp.y - h / 2 - fontUnit * 0.35}
                  textAnchor="middle"
                  fontSize={fontUnit}
                  fontWeight={600}
                  fill="var(--foreground)"
                  fontFamily="var(--font-mono, monospace)"
                >
                  {comp.kind === "power_symbol" ? comp.value : comp.ref}
                </text>
                {comp.kind !== "power_symbol" &&
                  (() => {
                    const displayVal = comp.value.slice(0, 14);
                    const fittedFont = Math.min(
                      fontUnit * 0.76,
                      (w * 0.86) / Math.max(3.5, displayVal.length * 0.62),
                    );
                    return (
                      <text
                        x={comp.x}
                        y={comp.y + fittedFont * 0.35}
                        textAnchor="middle"
                        fontSize={fittedFont}
                        fill="var(--muted-foreground)"
                        fontFamily="var(--font-mono, monospace)"
                      >
                        {displayVal}
                      </text>
                    );
                  })()}
              </g>
            );
          })}

          {model.labels
            .filter(
              (lbl) =>
                !(
                  lbl.kind === "power" &&
                  model.components.some(
                    (c) =>
                      c.kind === "power_symbol" &&
                      c.x !== undefined &&
                      c.y !== undefined &&
                      Math.abs(c.x - lbl.x) < 0.5 &&
                      Math.abs(c.y - lbl.y) < 0.5,
                  )
                ),
            )
            .map((lbl) => {
              const isHighlighted = lbl.text === selectedNet || traceNets.has(lbl.text);
              return (
                <text
                  key={`lbl:${lbl.kind}:${lbl.text}:${lbl.x}:${lbl.y}`}
                  x={lbl.x}
                  y={lbl.y - fontUnit * 0.3}
                  fontSize={fontUnit * 0.85}
                  fontWeight={isHighlighted ? 700 : 500}
                  fill={
                    isHighlighted
                      ? "var(--warning, #f59e0b)"
                      : lbl.kind === "power"
                        ? "var(--destructive, #ef4444)"
                        : "var(--info, #38bdf8)"
                  }
                  fontFamily="var(--font-mono, monospace)"
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectNet(lbl.text);
                  }}
                >
                  {lbl.text}
                </text>
              );
            })}

          {validationIssues.map((issue) => {
            if (issue.x === undefined || issue.y === undefined) return null;
            const fill =
              issue.severity === "error"
                ? "var(--destructive, #ef4444)"
                : issue.severity === "warning"
                  ? "var(--warning, #eab308)"
                  : "var(--info, #3b82f6)";
            return (
              <g
                key={`issue:${issue.id}`}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  if (issue.net) onSelectNet(issue.net);
                  if (issue.refs[0]) onSelectRef(issue.refs[0]);
                }}
              >
                <circle cx={issue.x} cy={issue.y} r={strokeUnit * 3.1} fill={fill} opacity={0.22} />
                <circle
                  cx={issue.x}
                  cy={issue.y}
                  r={strokeUnit * 1.7}
                  fill={fill}
                  stroke="var(--background)"
                  strokeWidth={strokeUnit * 0.45}
                >
                  <title>{`[${issue.severity.toUpperCase()}] ${issue.message}`}</title>
                </circle>
              </g>
            );
          })}
        </svg>
      </div>

      {(selectedComponent || selectedNetObj) && (
        <div className="border-t border-border bg-card/80 px-3 py-2 text-xs">
          {selectedComponent ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-foreground">
                    {selectedComponent.ref}
                  </span>
                  <span className="text-muted-foreground">{selectedComponent.value}</span>
                  {selectedComponent.footprint && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                      {selectedComponent.footprint}
                    </span>
                  )}
                </div>
                {onStartTraceFrom && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onStartTraceFrom(selectedComponent.ref)}
                  >
                    <T>Trace from here</T>
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {selectedComponent.pins.map((pin) => (
                  <button
                    key={pin.number}
                    type="button"
                    className="rounded border border-border/80 bg-background px-1.5 py-0.5 font-mono text-2xs hover:border-primary"
                    onClick={() => {
                      if (pin.net) onSelectNet(pin.net);
                    }}
                  >
                    <span className="text-muted-foreground">
                      {pin.number}
                      {pin.name ? `(${pin.name})` : ""}:
                    </span>{" "}
                    <span className={pin.net ? "text-foreground" : "text-destructive"}>
                      {pin.net ?? "NC"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : selectedNetObj ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-primary">
                    {selectedNetObj.name}
                  </span>
                  <span className="text-muted-foreground">
                    {gt("{count} connected pins", { count: selectedNetObj.pins.length })}
                  </span>
                </div>
                {onStartTraceFrom && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onStartTraceFrom(selectedNetObj.name)}
                  >
                    <T>Trace from net</T>
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {selectedNetObj.pins.map((p) => (
                  <button
                    key={`${p.ref}:${p.pin}`}
                    type="button"
                    className="rounded border border-border/70 bg-background px-1.5 py-0.5 font-mono text-2xs hover:border-primary"
                    onClick={() => onSelectRef(p.ref)}
                  >
                    {p.ref}.{p.pin}
                    {p.pinName ? ` (${p.pinName})` : ""}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
