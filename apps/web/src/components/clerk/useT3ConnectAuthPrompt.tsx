import { useClerk } from "@clerk/react";
import { useState } from "react";

import { isElectron } from "../../env";
import { Dialog, DialogPopup } from "../ui/dialog";
import { DesktopClerkWaitlist } from "./DesktopClerkWaitlist";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const [desktopAuthOpen, setDesktopAuthOpen] = useState(false);

  const openAuthPrompt = () => {
    if (isElectron) {
      setDesktopAuthOpen(true);
      return;
    }
    clerk.openWaitlist();
  };

  const authPrompt = isElectron ? (
    <Dialog open={desktopAuthOpen} onOpenChange={setDesktopAuthOpen}>
      <DialogPopup className="max-w-md border-0 bg-transparent shadow-none" showCloseButton={false}>
        <DesktopClerkWaitlist />
      </DialogPopup>
    </Dialog>
  ) : null;

  return { authPrompt, openAuthPrompt };
}
