import { useAtomValue } from "@effect/atom-react";
import { T } from "gt-react";

import { preferencesSync } from "../../clientProfile/preferencesSync";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export function PreferencesSyncChoiceDialog() {
  const status = useAtomValue(preferencesSync.statusAtom);
  return (
    <AlertDialog
      open={status.type === "choice"}
      onOpenChange={(open) => {
        if (!open) void preferencesSync.cancelChoice();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>Sync preferences</T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <T>
              Other devices already sync preferences through your servers. Choose which settings to
              keep.
            </T>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 px-6 pb-4 text-muted-foreground text-sm">
          <p>
            <T>
              Use synced settings: this device switches to the preferences your other devices share.
            </T>
          </p>
          <p>
            <T>Use this device's settings: all your devices switch to this device's preferences.</T>
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button variant="outline" onClick={() => void preferencesSync.choose("thisDevice")}>
            <T>Use this device's settings</T>
          </Button>
          <Button onClick={() => void preferencesSync.choose("synced")}>
            <T>Use synced settings</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
