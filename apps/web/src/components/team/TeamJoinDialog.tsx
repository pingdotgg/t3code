import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { TeamJoinForm } from "./TeamJoinForm";
import { closeTeamJoinDialog, teamJoinDialogRequestAtom } from "./teamJoinDialogState";

export function TeamJoinDialogHost() {
  const request = useAtomValue(teamJoinDialogRequestAtom);
  const gt = useGT();
  if (request === null) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeTeamJoinDialog();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Join team</T>
          </DialogTitle>
          <DialogDescription>
            <T>Confirm your pseudo to connect to this shared team server.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <TeamJoinForm
            key={`${request.serverUrl}:${request.token}`}
            initialServerUrl={request.serverUrl}
            initialToken={request.token}
            initialPseudo={request.prefilledPseudo}
            onCancel={closeTeamJoinDialog}
            onJoined={(result) => {
              closeTeamJoinDialog();
              toastManager.add({
                type: "success",
                title: gt("Joined {teamName}", { teamName: result.team.name }),
                description: gt("Connected as {pseudo}.", { pseudo: result.member.pseudo }),
              });
            }}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
