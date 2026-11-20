import { useAtomValue } from "@effect/atom-react";
import { Fragment, useSyncExternalStore } from "react";

import { ProviderGlyph } from "./ProviderGlyph";
import { Tooltip } from "../ui/Tooltip";
import { engineProvidersAtom } from "../state/server";
import { describeUsage, UNAVAILABLE_DASH } from "./usage";

const TICK_MS = 30_000;

// Reset times shown in minutes and hours change slowly, so the clock moves in whole ticks.
function subscribeToClock(onTick: () => void) {
  const timer = setInterval(onTick, TICK_MS);
  return () => clearInterval(timer);
}
const readClock = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

export function UsageBar() {
  const providers = useAtomValue(engineProvidersAtom);
  const now = useSyncExternalStore(subscribeToClock, readClock);
  const usage = describeUsage(providers, now);

  return (
    <footer
      aria-label="Usage"
      className="flex h-7 items-center gap-4 overflow-x-clip border-t border-line bg-sidebar px-3 text-xs text-muted"
    >
      <span>Used</span>
      {usage.map((provider) => (
        <span
          key={provider.instanceId}
          className="flex items-center gap-1.5 whitespace-nowrap"
          data-provider={provider.instanceId}
        >
          <ProviderGlyph driver={provider.driver} />
          {provider.segments.map((segment, index) => (
            <Fragment key={segment.key}>
              {index > 0 && <span aria-hidden>·</span>}
              <Tooltip text={segment.title}>
                <span
                  tabIndex={0}
                  className={segment.text === UNAVAILABLE_DASH ? "text-faint" : "text-fg"}
                >
                  {segment.text}
                </span>
              </Tooltip>
            </Fragment>
          ))}
        </span>
      ))}
    </footer>
  );
}
