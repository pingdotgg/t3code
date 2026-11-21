import type { PrinterSnapshot, PrinterSpool } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { Disc3, Droplets } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

interface PrinterFilamentStripProps {
  readonly filament: PrinterSnapshot["filament"];
}

function SpoolSwatch({
  colorHex,
  empty,
}: {
  readonly colorHex: string | null;
  readonly empty: boolean;
}) {
  return (
    <span
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center rounded-full border border-border",
        empty ? "border-dashed bg-muted/40" : "bg-muted",
      )}
      style={!empty && colorHex ? { backgroundColor: colorHex } : undefined}
    >
      <span className="size-2 rounded-full border border-border/70 bg-background/90" />
    </span>
  );
}

function SpoolTile({ spool }: { readonly spool: PrinterSpool }) {
  const gt = useGT();
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-border/60 bg-card/60 p-2",
        spool.active && "border-primary/60 ring-1 ring-inset ring-primary/40",
      )}
    >
      <div className="flex items-center justify-between gap-1.5">
        <SpoolSwatch colorHex={spool.colorHex} empty={spool.empty} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-2xs font-medium text-foreground">
            {spool.empty ? gt("Empty") : (spool.material ?? spool.label)}
          </div>
          <div className="truncate text-3xs text-muted-foreground tabular-nums">
            {spool.label}
            {spool.remainingPercent !== null ? ` · ${spool.remainingPercent}%` : ""}
          </div>
        </div>
      </div>
      {spool.active ? (
        <Badge size="sm" variant="info" className="w-fit">
          {gt("Feeding")}
        </Badge>
      ) : null}
    </div>
  );
}

export function PrinterFilamentStrip({ filament }: PrinterFilamentStripProps) {
  const gt = useGT();
  const hasAms = filament.amsUnits.length > 0;
  const hasExternal = filament.externalSpool !== null;

  if (!hasAms && !hasExternal && filament.extruderLoaded === null) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Disc3 className="size-3.5 text-muted-foreground" />
          {hasAms ? gt("AMS & Filament") : gt("Filament")}
        </span>
        {filament.extruderLoaded !== null ? (
          <Badge size="sm" variant={filament.extruderLoaded ? "success" : "secondary"}>
            {filament.extruderLoaded ? gt("Extruder loaded") : gt("Extruder empty")}
          </Badge>
        ) : null}
      </div>

      {filament.amsUnits.map((unit) => (
        <div key={unit.id} className="space-y-1.5">
          <div className="flex items-center justify-between text-2xs text-muted-foreground">
            <span className="font-medium">{unit.label}</span>
            <div className="flex items-center gap-2 tabular-nums">
              {unit.humidityIndex !== null ? (
                <span className="inline-flex items-center gap-0.5">
                  <Droplets className="size-3" />
                  {gt("Humidity {level}/5", { level: unit.humidityIndex })}
                </span>
              ) : null}
              {unit.temperatureC !== null ? <span>{Math.round(unit.temperatureC)}°C</span> : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 @[420px]:grid-cols-4">
            {unit.trays.map((tray) => (
              <SpoolTile key={tray.id} spool={tray} />
            ))}
          </div>
        </div>
      ))}

      {filament.externalSpool ? (
        <div
          className={cn(
            "flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-2",
            filament.externalSpool.active && "border-primary/60 ring-1 ring-inset ring-primary/40",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <SpoolSwatch
              colorHex={filament.externalSpool.colorHex}
              empty={filament.externalSpool.empty}
            />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-foreground">
                {gt("External Spool")}
              </div>
              <div className="truncate text-2xs text-muted-foreground">
                {filament.externalSpool.material ??
                  (filament.externalSpool.active ? gt("Loaded (untyped)") : gt("Not configured"))}
              </div>
            </div>
          </div>
          {filament.externalSpool.active ? (
            <Badge size="sm" variant="info">
              {gt("Active")}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
