import { useState } from "react";
import type { LinkedJiraTicket } from "@t3tools/contracts";
import {
  BugIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  MessageSquareIcon,
  TicketIcon,
} from "lucide-react";
import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { readNativeApi } from "~/nativeApi";
import { CreateJiraTicketDialog } from "./CreateJiraTicketDialog";
import { UpdateJiraProgressDialog } from "./UpdateJiraProgressDialog";
import { FinishJiraTicketDialog } from "./FinishJiraTicketDialog";

interface JiraActionsControlProps {
  threadId: string;
  linkedJiraTicket: LinkedJiraTicket | null;
  onTicketLinked: (ticket: LinkedJiraTicket) => void;
  onTicketUpdated: (ticket: LinkedJiraTicket) => void;
}

export function JiraActionsControl({
  threadId,
  linkedJiraTicket,
  onTicketLinked,
  onTicketUpdated,
}: JiraActionsControlProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [showFinishDialog, setShowFinishDialog] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleOpenInBrowser = () => {
    if (!linkedJiraTicket) return;
    const api = readNativeApi();
    if (api) {
      void api.shell.openExternal(linkedJiraTicket.url);
    }
  };

  if (!linkedJiraTicket) {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => setShowCreateDialog(true)}>
          <TicketIcon className="size-3.5" />
          <span className="ml-1 text-xs">Jira</span>
        </Button>

        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          {showCreateDialog && (
            <DialogPopup>
              <CreateJiraTicketDialog
                threadId={threadId}
                onClose={() => setShowCreateDialog(false)}
                onTicketLinked={onTicketLinked}
              />
            </DialogPopup>
          )}
        </Dialog>
      </>
    );
  }

  const isCompleted = linkedJiraTicket.status === "completed";

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={
                isCompleted
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-blue-600 dark:text-blue-400"
              }
            />
          }
        >
          {isCompleted ? (
            <CheckCircle2Icon className="size-3.5" />
          ) : (
            <BugIcon className="size-3.5" />
          )}
          <span className="ml-1 text-xs">{linkedJiraTicket.key}</span>
        </PopoverTrigger>
        <PopoverPopup>
          <Menu>
            <MenuItem onClick={handleOpenInBrowser}>
              <ExternalLinkIcon className="size-3.5 mr-2" />
              View in Jira
            </MenuItem>
            {!isCompleted && (
              <>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    setShowUpdateDialog(true);
                  }}
                >
                  <MessageSquareIcon className="size-3.5 mr-2" />
                  Update Progress
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    setShowFinishDialog(true);
                  }}
                >
                  <CheckCircle2Icon className="size-3.5 mr-2" />
                  Finish Ticket
                </MenuItem>
              </>
            )}
          </Menu>
        </PopoverPopup>
      </Popover>

      <Dialog open={showUpdateDialog} onOpenChange={setShowUpdateDialog}>
        {showUpdateDialog && (
          <DialogPopup>
            <UpdateJiraProgressDialog
              ticket={linkedJiraTicket}
              onClose={() => setShowUpdateDialog(false)}
            />
          </DialogPopup>
        )}
      </Dialog>

      <Dialog open={showFinishDialog} onOpenChange={setShowFinishDialog}>
        {showFinishDialog && (
          <DialogPopup>
            <FinishJiraTicketDialog
              ticket={linkedJiraTicket}
              threadId={threadId}
              onClose={() => setShowFinishDialog(false)}
              onTicketUpdated={onTicketUpdated}
            />
          </DialogPopup>
        )}
      </Dialog>
    </>
  );
}
