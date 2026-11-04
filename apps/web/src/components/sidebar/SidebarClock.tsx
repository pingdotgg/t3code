import { memo, useEffect, useState } from "react";

import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });

/** The local time with seconds; only this text re-renders each second. */
export const SidebarClock = memo(function SidebarClock() {
  const [now, setNow] = useState(() => new Date());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks with the wall clock
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = new Date();
      setNow(current);
      // Aligned to the next whole second, so the display never lags a tick behind.
      timeout = setTimeout(tick, 1000 - current.getMilliseconds());
    };
    timeout = setTimeout(tick, 1000 - new Date().getMilliseconds());
    return () => clearTimeout(timeout);
  }, []);

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <time
              dateTime={now.toISOString()}
              className="flex h-8 items-center px-2 text-xs tabular-nums text-muted-foreground"
            >
              {timeFormat.format(now)}
            </time>
          }
        />
        <TooltipPopup side="top">{dateFormat.format(now)}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
});
