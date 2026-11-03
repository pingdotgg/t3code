import { ChevronDownIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Sits `bottom` pixels up, clear of the composer and its attached banners. The summary names
 * what waits at the end of the timeline, which is out of view while it shows.
 */
export function ScrollToEndButton(props: {
  readonly bottom: number;
  readonly summary: ReadonlyArray<string>;
  readonly onScrollToEnd: () => void;
}) {
  return (
    <div
      className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
      style={{ bottom: props.bottom }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              data-scroll-to-end="true"
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onScrollToEnd}
              className="pointer-events-auto"
              size="xs"
              variant="floating"
            />
          }
        >
          <ChevronDownIcon className="size-3.5" />
          Scroll to end
        </TooltipTrigger>
        <TooltipPopup>
          {props.summary.length
            ? props.summary.map((part) => (
                <span className="block" key={part}>
                  {part}
                </span>
              ))
            : "Scroll to end"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
