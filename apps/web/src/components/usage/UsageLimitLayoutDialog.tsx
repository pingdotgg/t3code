import {
  cursorUsageWindowDetails,
  displayLimitWindows,
  type LimitPool,
} from "@t3tools/shared/usageLimits";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { providerClients } from "../settings/providerDriverMeta";
import {
  DEFAULT_LIMIT_LAYOUT,
  limitWindowKey,
  moveLimitItem,
  orderLimitItems,
  type UsageLimitLayout,
} from "./usageLimitLayout";

function MoveButtons({
  label,
  index,
  count,
  onMove,
}: {
  readonly label: string;
  readonly index: number;
  readonly count: number;
  readonly onMove: (direction: -1 | 1) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={`Move ${label} down`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDownIcon />
      </Button>
    </span>
  );
}

export function UsageLimitLayoutDialog({
  pools,
  layout,
  onChange,
  open,
  onOpenChange,
}: {
  readonly pools: readonly LimitPool[];
  readonly layout: UsageLimitLayout;
  readonly onChange: (layout: UsageLimitLayout) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Customize limits</DialogTitle>
          <DialogDescription>
            Choose which limits to show and move them into your preferred order. Saved on this
            device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-5">
            {pools.map((pool, providerIndex) => {
              const windows = orderLimitItems(
                displayLimitWindows(pool),
                layout.windowOrder,
                (window) => limitWindowKey(pool.driver, window),
              );
              const providerLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
              return (
                <section key={pool.driver} className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium">{providerLabel}</h3>
                    <MoveButtons
                      label={providerLabel}
                      index={providerIndex}
                      count={pools.length}
                      onMove={(direction) =>
                        onChange({
                          ...layout,
                          providerOrder: moveLimitItem(
                            layout.providerOrder,
                            pools.map((item) => item.driver),
                            pool.driver,
                            direction,
                          ),
                        })
                      }
                    />
                  </div>
                  {windows.map((window, index) => {
                    const key = limitWindowKey(pool.driver, window);
                    const label =
                      (pool.driver === "cursor"
                        ? cursorUsageWindowDetails(window.id, pool)?.label
                        : undefined) ?? window.label;
                    const name = `${providerLabel} ${label}`;
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-3 rounded-md px-2 py-1"
                      >
                        <label className="flex min-w-0 items-center gap-2 text-sm">
                          <Checkbox
                            aria-label={`Show ${name}`}
                            checked={!layout.hiddenWindows.includes(key)}
                            onCheckedChange={(checked) =>
                              onChange({
                                ...layout,
                                hiddenWindows: checked
                                  ? layout.hiddenWindows.filter((id) => id !== key)
                                  : [...layout.hiddenWindows, key],
                              })
                            }
                          />
                          <span>{label}</span>
                        </label>
                        <MoveButtons
                          label={name}
                          index={index}
                          count={windows.length}
                          onMove={(direction) =>
                            onChange({
                              ...layout,
                              windowOrder: moveLimitItem(
                                layout.windowOrder,
                                windows.map((item) => limitWindowKey(pool.driver, item)),
                                key,
                                direction,
                              ),
                            })
                          }
                        />
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onChange(DEFAULT_LIMIT_LAYOUT)}>
            Reset layout
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
