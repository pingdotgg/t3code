import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { readLocalApi } from "../localApi";
import { primaryBedtimeReminderAtom } from "../state/server";
import { Button } from "./ui/button";

const RICKROLL_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const OVERLAY_ID = "t3-bedtime-overlay";

/** Inescapable while "reminding": Dismiss rickrolls, OK collapses to a pinned
 * corner card, and a watchdog re-attaches the node if it is removed. */
export function BedtimeReminderOverlay() {
  const reminder = useAtomValue(primaryBedtimeReminderAtom);
  const [collapsedFor, setCollapsedFor] = useState<string | null>(null);
  const reminding = reminder?.kind === "reminding";
  const collapsed = reminding && collapsedFor === reminder.nightStartedAt;

  // The portal target is owned by this component, not React: if external code
  // removes the node, its rendered subtree survives inside and the watchdog
  // only has to append it back.
  const [container] = useState(() => {
    const el = document.createElement("div");
    el.id = OVERLAY_ID;
    return el;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the reminder DOM node alive while reminding; re-adds it if it is removed outside React.
  useEffect(() => {
    if (!reminding) return;
    document.body.appendChild(container);
    const watchdog = window.setInterval(() => {
      if (container.parentNode !== document.body) document.body.appendChild(container);
    }, 300);
    return () => {
      window.clearInterval(watchdog);
      container.remove();
    };
  }, [container, reminding]);

  if (!reminding) return null;
  return createPortal(
    <div role="alert">
      {collapsed ? (
        <div className="fixed top-4 right-4 z-2147483647 w-80 rounded-xl border border-border bg-background p-5 shadow-2xl select-none">
          <p className="text-base font-semibold text-foreground">Hey, it's getting late</p>
          <p className="mt-1 text-sm text-muted-foreground">go to sleep</p>
        </div>
      ) : (
        <div className="fixed inset-0 z-2147483647 flex items-center justify-center bg-background/80 p-10 backdrop-blur-sm">
          <div className="flex h-full w-full flex-col items-center justify-center gap-10 rounded-xl border border-border bg-background text-center shadow-2xl">
            <div className="space-y-4 px-8">
              <p className="text-6xl font-black tracking-tight text-foreground md:text-8xl">
                Hey, it's getting late
              </p>
              <p className="text-4xl font-bold text-muted-foreground md:text-6xl">go to sleep</p>
            </div>
            <div className="flex gap-4">
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  void readLocalApi()?.shell.openExternal(RICKROLL_URL);
                }}
              >
                Dismiss
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => setCollapsedFor(reminder.nightStartedAt)}
              >
                OK
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>,
    container,
  );
}
