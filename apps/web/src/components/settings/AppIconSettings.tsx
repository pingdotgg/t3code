import { DEFAULT_APP_ICON } from "@t3tools/shared/appIcons";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { APP_ICON_OPTIONS, appIconOption } from "../../appIcon";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { Button, ContentButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

function AppIconPickerDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const current = appIconOption(useClientSettings((settings) => settings.appIcon));
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>App icon</T>
          </DialogTitle>
          <DialogDescription>
            <T>Used for the Dock, taskbar, and browser tab.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div aria-label={gt("App icon")} className="grid grid-cols-3 gap-3" role="group">
            {APP_ICON_OPTIONS.map((option) => {
              const isActive = option.id === current.id;
              return (
                <ContentButton
                  aria-pressed={isActive}
                  key={option.id}
                  onClick={() => void updateClientSettings({ appIcon: option.id })}
                  variant="selection-card"
                >
                  <span className="flex flex-col items-center gap-2 p-3">
                    <img alt="" className="size-16" draggable={false} src={option.src} />
                    <span
                      className={cn(
                        "text-meta",
                        isActive ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {messages(option.label)}
                    </span>
                  </span>
                </ContentButton>
              );
            })}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function AppIconRow() {
  const gt = useGT();
  const messages = useMessages();
  const searchableSetting = useSearchableSetting();
  const [open, setOpen] = useState(false);
  const appIcon = useClientSettings((settings) => settings.appIcon);
  const current = appIconOption(appIcon);
  return (
    <SettingsRow
      {...searchableSetting("app-icon")}
      description={gt("Choose the icon for the Dock, taskbar, and browser tab on this device.")}
      resetAction={
        current.id !== DEFAULT_APP_ICON ? (
          <SettingResetButton
            ariaLabel={gt("Reset app icon to default")}
            onClick={() => void updateClientSettings({ appIcon: DEFAULT_APP_ICON })}
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Button className="w-full" onClick={() => setOpen(true)} size="sm" variant="secondary">
            <img alt="" className="size-4" draggable={false} src={current.src} />
            {messages(current.label)}
          </Button>
          <AppIconPickerDialog onOpenChange={setOpen} open={open} />
        </div>
      }
    />
  );
}
