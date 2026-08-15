import { useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { BraveIcon, EdgeIcon, FirefoxIcon } from "./browserBrandIcons";
import { SettingsRow } from "./settingsLayout";

function RowTitle({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {icon}
      {children}
    </span>
  );
}

/** Chromium/Firefox setup disclosure for Computer Use settings. */
export function ComputerUseMoreBrowsers() {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SettingsRow
        title={<RowTitle icon={<EdgeIcon className="size-5" />}>More browsers</RowTitle>}
        description="Set up the same extension in other Chromium browsers."
        control={
          <CollapsibleTrigger
            render={<Button type="button" variant="outline" size="sm" />}
            aria-controls="computer-use-more-browsers"
          >
            {open ? "Hide" : "Show"}
          </CollapsibleTrigger>
        }
      >
        <CollapsiblePanel id="computer-use-more-browsers">
          <div className="mt-2 space-y-3 rounded-xl bg-muted/20 px-3 py-3">
            <div className="flex items-center gap-3">
              <EdgeIcon className="size-6" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Microsoft Edge</p>
                <p className="text-[13px] text-muted-foreground">
                  Load the unpacked extension from edge://extensions
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <BraveIcon className="size-6" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Brave</p>
                <p className="text-[13px] text-muted-foreground">
                  Same extension via brave://extensions
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 opacity-70">
              <FirefoxIcon className="size-6" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Firefox</p>
                <p className="text-[13px] text-muted-foreground">Not supported yet</p>
              </div>
            </div>
          </div>
        </CollapsiblePanel>
      </SettingsRow>
    </Collapsible>
  );
}
