import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { issueTrackingEnvironment } from "../../state/issueTracking";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinearIcon } from "../Icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function LinearConnectionDialog({
  open,
  environmentId,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  environmentId: EnvironmentId;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const connect = useAtomCommand(issueTrackingEnvironment.linearConnect, { reportFailure: false });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeDialog = (nextOpen: boolean) => {
    if (busy) return;
    setToken("");
    setError(null);
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={closeDialog}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <LinearIcon className="size-4.5" />
            Add Linear account
          </DialogTitle>
          <DialogDescription>
            Enter your personal Linear API key to connect your account.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="linear-connect-form"
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || token.trim().length === 0) return;
              setBusy(true);
              setError(null);
              const result = await connect({
                environmentId,
                input: { token: token.trim(), mode: "add" },
              });
              setBusy(false);
              if (result._tag === "Failure") {
                setError(formatEnvironmentQueryError(result.cause));
                return;
              }
              setToken("");
              onConnected();
              onOpenChange(false);
            }}
          >
            <label className="block text-sm font-medium" htmlFor="linear-api-key">
              API key
            </label>
            <Input
              id="linear-api-key"
              type="password"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              placeholder="lin_api_…"
              aria-label="Linear API key"
              autoComplete="off"
              disabled={busy}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => closeDialog(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="linear-connect-form"
            disabled={busy || token.trim().length === 0}
          >
            {busy ? "Adding…" : "Add account"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
