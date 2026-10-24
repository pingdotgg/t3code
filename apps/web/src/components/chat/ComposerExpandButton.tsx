/** Offers more editing space only when the compact prompt has vertical overflow. */
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useLayoutEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { useComposerViewport } from "./ComposerViewport";

const OVERFLOW_ROUNDING_TOLERANCE_PX = 1;

export function ComposerExpandButton({ anchor }: { anchor: HTMLElement | null }) {
  const { maximized, setMaximized } = useComposerViewport();
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    if (!anchor || maximized) return;
    const measure = () => {
      const editor = anchor.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      setOverflows(
        editor !== null &&
          editor.clientHeight > 0 &&
          editor.scrollHeight > editor.clientHeight + OVERFLOW_ROUNDING_TOLERANCE_PX,
      );
    };
    measure();
    const editor = anchor.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    const stopObserving = observeResize(editor ? [anchor, editor] : anchor, measure);
    const mutations = new MutationObserver(measure);
    mutations.observe(anchor, { childList: true, characterData: true, subtree: true });
    return () => {
      stopObserving();
      mutations.disconnect();
    };
  }, [anchor, maximized]);

  if (!maximized && !overflows) return null;

  const label = maximized ? "Restore prompt size" : "Maximize prompt";
  return (
    <div className="absolute top-1 right-1 z-10">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={label}
              aria-expanded={maximized}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => setMaximized(!maximized)}
            />
          }
        >
          {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
