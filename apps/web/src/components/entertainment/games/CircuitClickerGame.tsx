import { AwardIcon, CpuIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { readGameSave, writeGameSave } from "../entertainmentStore";
import {
  availableUpgrades,
  buildingCost,
  buyBuilding,
  buyUpgrade,
  CLICKER_ACHIEVEMENTS,
  CLICKER_BUILDINGS,
  clickCore,
  type ClickerState,
  cyclesPerClick,
  cyclesPerSecond,
  formatCycles,
  newClicker,
  parseClickerSave,
  tickClicker,
} from "./circuitClicker.logic";

const SAVE_KEY = "circuit-clicker";
const CORE_STYLE = {
  background: "radial-gradient(circle at 35% 30%, #fde68a, #f59e0b 45%, #b45309)",
  boxShadow: "0 0 60px rgba(245, 158, 11, 0.35)",
};
const AUTOSAVE_MS = 5_000;

function load(): ClickerState {
  const saved = parseClickerSave(readGameSave(SAVE_KEY));
  return saved ? tickClicker(saved, Date.now()) : newClicker(Date.now());
}

/** Circuit Clicker, Continuum's original incremental game, saved on this device. */
export function CircuitClickerGame({ visible }: { readonly visible: boolean }) {
  const [state, setState] = useState(load);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const save = useEffectEvent(() => {
    writeGameSave(SAVE_KEY, JSON.stringify(state));
    setSavedAt(Date.now());
  });
  const advance = useEffectEvent(() => setState((current) => tickClicker(current, Date.now())));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- production advances on a timer while the game is visible; offline time is added on return
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => advance(), 250);
    return () => window.clearInterval(timer);
  }, [visible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- autosaves to this device's storage on a timer and when the game closes
  useEffect(() => {
    const timer = window.setInterval(() => save(), AUTOSAVE_MS);
    const onHide = () => save();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", onHide);
      save();
    };
  }, []);

  const perSecond = cyclesPerSecond(state);
  const upgrades = availableUpgrades(state);

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_minmax(16rem,22rem)]">
      <div className="flex flex-col items-center gap-4">
        <div className="text-center">
          <div className="font-semibold text-3xl tabular-nums">{formatCycles(state.cycles)}</div>
          <div className="text-muted-foreground text-sm">
            cycles · {formatCycles(perSecond)} per second · {formatCycles(cyclesPerClick(state))}{" "}
            per click
          </div>
        </div>
        <button
          type="button"
          aria-label="Click the core to make cycles"
          onClick={() => setState(clickCore)}
          className="group relative flex size-48 items-center justify-center rounded-full bg-arcade-amber transition-transform active:scale-95 motion-safe:hover:scale-105"
          style={CORE_STYLE}
        >
          <CpuIcon className="size-20 text-arcade-ember" />
        </button>
        <div className="text-muted-foreground text-xs">
          {state.clicks.toLocaleString()} clicks · {formatCycles(state.totalCycles)} made in total
          {savedAt ? ` · saved ${new Date(savedAt).toLocaleTimeString()}` : ""}
        </div>
        <section className="w-full max-w-xl">
          <h4 className="mb-2 flex items-center gap-1.5 font-medium text-sm">
            <AwardIcon className="size-4" /> Achievements {state.achievements.length}/
            {CLICKER_ACHIEVEMENTS.length}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {CLICKER_ACHIEVEMENTS.map((achievement) => {
              const earned = state.achievements.includes(achievement.id);
              return (
                <Badge key={achievement.id} variant={earned ? "warning" : "outline"}>
                  {earned ? achievement.name : "???"}
                  <span className="sr-only">: {achievement.description}</span>
                </Badge>
              );
            })}
          </div>
        </section>
        <div className="flex gap-2">
          {confirmReset ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  const fresh = newClicker(Date.now());
                  setState(fresh);
                  writeGameSave(SAVE_KEY, JSON.stringify(fresh));
                  setConfirmReset(false);
                }}
              >
                Erase my progress
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                Keep playing
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>
              <RotateCcwIcon /> Reset
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => save()}>
            Save now
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {upgrades.length > 0 ? (
          <section>
            <h4 className="mb-1.5 font-medium text-sm">Upgrades</h4>
            <div className="flex flex-col gap-1.5">
              {upgrades.map((upgrade) => (
                <button
                  key={upgrade.id}
                  type="button"
                  disabled={state.cycles < upgrade.cost}
                  onClick={() => setState((current) => buyUpgrade(current, upgrade.id))}
                  className="flex flex-col rounded-lg border border-arcade-amber/40 bg-arcade-amber/10 p-2 text-start text-sm transition-colors hover:bg-arcade-amber/20 disabled:opacity-50"
                >
                  <span className="flex justify-between gap-2 font-medium">
                    {upgrade.name}
                    <span className="tabular-nums">{formatCycles(upgrade.cost)}</span>
                  </span>
                  <span className="text-muted-foreground text-xs">{upgrade.description}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <h4 className="mb-1.5 font-medium text-sm">Hardware</h4>
          <div className="flex flex-col gap-1.5">
            {CLICKER_BUILDINGS.map((building, index) => {
              const owned = state.owned[building.id] ?? 0;
              const previousOwned =
                index === 0 || (state.owned[CLICKER_BUILDINGS[index - 1]!.id] ?? 0) > 0;
              if (!previousOwned && owned === 0) return null;
              const cost = buildingCost(building, owned);
              return (
                <button
                  key={building.id}
                  type="button"
                  disabled={state.cycles < cost}
                  onClick={() => setState((current) => buyBuilding(current, building.id))}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card/60 p-2 text-start text-sm transition-colors hover:bg-accent/40 disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{building.name}</span>
                    <span className="block text-muted-foreground text-xs">
                      {building.description} {formatCycles(building.rate)}/s each
                    </span>
                  </span>
                  <span className="text-end">
                    <span className="block font-semibold tabular-nums">{owned}</span>
                    <span className="block text-muted-foreground text-xs tabular-nums">
                      {formatCycles(cost)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
