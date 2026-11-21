import type { PrinterAction, PrinterSnapshot, PrinterSpeedProfile } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Fan,
  Gauge,
  Home,
  Lock,
  Move,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { isActiveJobStatus } from "./printerFormat";

interface PrinterControlsDeckProps {
  readonly printer: PrinterSnapshot;
  readonly canControl: boolean;
  readonly pendingAction: string | null;
  readonly onAction: (action: PrinterAction) => void;
}

const SPEED_OPTIONS = [
  { value: "silent", label: msg("Silent"), pct: "50%" },
  { value: "standard", label: msg("Std"), pct: "100%" },
  { value: "sport", label: msg("Sport"), pct: "124%" },
  { value: "ludicrous", label: msg("Ludicrous"), pct: "166%" },
] as const satisfies ReadonlyArray<{
  readonly value: PrinterSpeedProfile;
  readonly label: unknown;
  readonly pct: string;
}>;

const FAN_STEPS = [0, 20, 40, 60, 80, 100] as const;
const JOG_STEPS = [0.1, 1, 10] as const;

function FanControlRow({
  label,
  percent,
  fan,
  disabled,
  onSetFan,
}: {
  readonly label: string;
  readonly percent: number | null;
  readonly fan: "cooling" | "aux" | "chamber";
  readonly disabled: boolean;
  readonly onSetFan: (fan: "cooling" | "aux" | "chamber", percent: number) => void;
}) {
  const gt = useGT();
  const displayPct = percent ?? 0;

  const exactStep =
    percent !== null && (FAN_STEPS as ReadonlyArray<number>).includes(percent) ? percent : null;

  return (
    <div className="space-y-1.5 rounded-md border border-border/50 bg-background/40 p-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {percent === null ? "--" : `${percent}%`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-info transition-[width]"
          style={{ width: `${Math.max(0, Math.min(100, displayPct))}%` }}
        />
      </div>
      <ToggleGroup
        variant="segmented"
        className="w-full"
        value={exactStep !== null ? [String(exactStep)] : []}
        onValueChange={(values) => {
          const next = Number(values[0]);
          if (Number.isFinite(next)) onSetFan(fan, next);
        }}
      >
        {FAN_STEPS.map((step) => (
          <Toggle
            key={step}
            value={String(step)}
            disabled={disabled}
            className="flex-1"
            aria-label={gt("Set {fan} to {percent}%", { fan: label, percent: step })}
          >
            <span className="tabular-nums">{step === 0 ? gt("Off") : `${step}%`}</span>
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function PrinterControlsDeck({
  printer,
  canControl,
  pendingAction,
  onAction,
}: PrinterControlsDeckProps) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const [motionUnlocked, setMotionUnlocked] = useState(false);
  const [jogStep, setJogStep] = useState<number>(1);

  const busy = pendingAction !== null;
  const isJobActive = isActiveJobStatus(printer.job.status);
  const motionLockedByJob = isJobActive || !printer.capabilities.canJog;
  const [prevMotionLockedByJob, setPrevMotionLockedByJob] = useState(motionLockedByJob);
  if (prevMotionLockedByJob !== motionLockedByJob) {
    setPrevMotionLockedByJob(motionLockedByJob);
    if (motionLockedByJob && motionUnlocked) {
      setMotionUnlocked(false);
    }
  }
  const canJogNow = canControl && !busy && !motionLockedByJob && motionUnlocked;

  const hasCoolingFan = printer.fans.coolingPercent !== null;
  const hasAuxFan = printer.fans.auxPercent !== null;
  const hasChamberFan = printer.fans.chamberPercent !== null;
  const hasHeatbreakFan = printer.fans.heatbreakPercent !== null;

  return (
    <div className="space-y-3">
      {/* Speed profile */}
      {printer.speed.profile !== null || printer.capabilities.canSetSpeed ? (
        <div className="space-y-2 rounded-lg border border-border/60 bg-card/50 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Gauge className="size-3.5 text-muted-foreground" />
              {gt("Print speed")}
            </span>
            {printer.speed.modifierPercent !== null ? (
              <Badge size="sm" variant="secondary">
                {printer.speed.modifierPercent}%
              </Badge>
            ) : null}
          </div>
          <ToggleGroup
            variant="segmented"
            className="w-full"
            value={printer.speed.profile ? [printer.speed.profile] : []}
            onValueChange={(values) => {
              const next = values[0] as PrinterSpeedProfile | undefined;
              if (next && next !== printer.speed.profile) {
                onAction({ kind: "setSpeedProfile", profile: next });
              }
            }}
          >
            {SPEED_OPTIONS.map((option) => (
              <Toggle
                key={option.value}
                value={option.value}
                disabled={!canControl || !printer.capabilities.canSetSpeed || busy}
                className="flex-1"
              >
                <span>{resolveMessage(option.label)}</span>
              </Toggle>
            ))}
          </ToggleGroup>
          {!printer.capabilities.canSetSpeed && printer.online ? (
            <p className="text-2xs text-muted-foreground">
              {gt("Speed profile can be changed while a print is active.")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Fans */}
      {hasCoolingFan || hasAuxFan || hasChamberFan || hasHeatbreakFan ? (
        <div className="space-y-2 rounded-lg border border-border/60 bg-card/50 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Fan className="size-3.5 text-muted-foreground" />
              {gt("Cooling & Fans")}
            </span>
            {hasHeatbreakFan ? (
              <span className="text-2xs text-muted-foreground tabular-nums">
                {gt("Heatbreak: {percent}%", { percent: printer.fans.heatbreakPercent })}
              </span>
            ) : null}
          </div>

          <div className="space-y-2">
            {hasCoolingFan ? (
              <FanControlRow
                label={gt("Part cooling")}
                percent={printer.fans.coolingPercent}
                fan="cooling"
                disabled={!canControl || !printer.capabilities.canSetFans || busy}
                onSetFan={(fan, percent) => onAction({ kind: "setFanSpeed", fan, percent })}
              />
            ) : null}
            {hasAuxFan ? (
              <FanControlRow
                label={gt("Auxiliary fan")}
                percent={printer.fans.auxPercent}
                fan="aux"
                disabled={!canControl || !printer.capabilities.canSetFans || busy}
                onSetFan={(fan, percent) => onAction({ kind: "setFanSpeed", fan, percent })}
              />
            ) : null}
            {hasChamberFan ? (
              <FanControlRow
                label={gt("Chamber exhaust")}
                percent={printer.fans.chamberPercent}
                fan="chamber"
                disabled={!canControl || !printer.capabilities.canSetFans || busy}
                onSetFan={(fan, percent) => onAction({ kind: "setFanSpeed", fan, percent })}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Motion / Axis Jog Pad */}
      <div className="space-y-2.5 rounded-lg border border-border/60 bg-card/50 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Move className="size-3.5 text-muted-foreground" />
            {gt("Motion & Axis Jog")}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-2xs text-muted-foreground">{gt("Unlock")}</span>
            <Switch
              checked={!motionLockedByJob && motionUnlocked}
              disabled={!canControl || motionLockedByJob}
              aria-label={gt("Unlock motion controls")}
              onCheckedChange={(checked) => setMotionUnlocked(Boolean(checked))}
            />
          </div>
        </div>

        {motionLockedByJob ? (
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 text-2xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            <span>
              {isJobActive
                ? gt("Axis homing and jogging are locked while a print is running or paused.")
                : gt("Axis jog is unavailable while the printer is offline or write-locked.")}
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-muted-foreground">{gt("Step size")}</span>
              <ToggleGroup
                variant="segmented"
                value={[String(jogStep)]}
                onValueChange={(values) => {
                  const next = Number(values[0]);
                  if (Number.isFinite(next) && next > 0) setJogStep(next);
                }}
              >
                {JOG_STEPS.map((step) => (
                  <Toggle key={step} value={String(step)}>
                    {step} mm
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>

            <div className="grid grid-cols-[1fr_auto] items-center gap-3 pt-1">
              {/* XY Compass */}
              <div className="grid grid-cols-3 gap-1.5">
                <div />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canJogNow}
                  aria-label={gt("Move Y +{step} mm", { step: jogStep })}
                  onClick={() => onAction({ kind: "moveAxis", axis: "Y", distanceMm: jogStep })}
                >
                  <ArrowUp className="size-3.5" />
                  <span className="text-2xs">Y+</span>
                </Button>
                <div />

                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canJogNow}
                  aria-label={gt("Move X -{step} mm", { step: jogStep })}
                  onClick={() => onAction({ kind: "moveAxis", axis: "X", distanceMm: -jogStep })}
                >
                  <ArrowLeft className="size-3.5" />
                  <span className="text-2xs">X-</span>
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canJogNow}
                  aria-label={gt("Home all axes")}
                  onClick={() => onAction({ kind: "homeAxes" })}
                >
                  <Home className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canJogNow}
                  aria-label={gt("Move X +{step} mm", { step: jogStep })}
                  onClick={() => onAction({ kind: "moveAxis", axis: "X", distanceMm: jogStep })}
                >
                  <ArrowRight className="size-3.5" />
                  <span className="text-2xs">X+</span>
                </Button>

                <div />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canJogNow}
                  aria-label={gt("Move Y -{step} mm", { step: jogStep })}
                  onClick={() => onAction({ kind: "moveAxis", axis: "Y", distanceMm: -jogStep })}
                >
                  <ArrowDown className="size-3.5" />
                  <span className="text-2xs">Y-</span>
                </Button>
                <div />
              </div>

              {/* Z Bed Column (explicit bed-direction labels for Bambu P1S safety) */}
              <div className="flex flex-col gap-1.5 border-l border-border/60 pl-3">
                <span className="text-center text-3xs font-medium text-muted-foreground">
                  {gt("Bed Z")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canJogNow}
                  aria-label={gt("Raise bed (Z -{step} mm)", { step: jogStep })}
                  onClick={() => onAction({ kind: "moveAxis", axis: "Z", distanceMm: -jogStep })}
                >
                  <ArrowUp className="size-3.5" />
                  <span className="text-2xs">-Z</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canJogNow}
                  aria-label={gt("Lower bed (Z +{step} mm)", { step: jogStep })}
                  onClick={() => onAction({ kind: "moveAxis", axis: "Z", distanceMm: jogStep })}
                >
                  <ArrowDown className="size-3.5" />
                  <span className="text-2xs">+Z</span>
                </Button>
              </div>
            </div>
            <p className="text-2xs text-muted-foreground">
              {gt("Home before jogging after power cycling. Confirm the build plate is clear.")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
