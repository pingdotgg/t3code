import type { EnvironmentId, InstalledApplication } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useState } from "react";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";

const EMPTY_MESSAGE = {
  loading: "Looking for installed applications…",
  failed: "Could not read the installed applications on this environment.",
  loaded: "No installed applications found on this environment.",
} as const;

type LoadState =
  | { readonly kind: "loading" | "failed" }
  | { readonly kind: "loaded"; readonly applications: ReadonlyArray<InstalledApplication> };

/** Opens the project in an application installed on the environment host. */
export const OpenWithDialog = memo(function OpenWithDialog({
  environmentId,
  cwd,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const listApplications = useAtomCommand(shellEnvironment.listInstalledApplications, {
    reportFailure: false,
  });
  const openInApplication = useAtomCommand(shellEnvironment.openInApplication, "open with");
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // Scan on open, clear on close: the dialog stays mounted, so a stale list
  // would stay pickable for a frame with ids from the previous host.
  useEffect(() => {
    if (!open) {
      setState({ kind: "loading" });
      return;
    }
    let cancelled = false;
    void listApplications({ environmentId, input: undefined }).then((result) => {
      if (cancelled) return;
      setState(
        result._tag === "Success"
          ? { kind: "loaded", applications: result.value }
          : { kind: "failed" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, listApplications, open]);

  const pick = useCallback(
    (applicationId: string) => {
      onOpenChange(false);
      void openInApplication({ environmentId, input: { cwd, applicationId } });
    },
    [cwd, environmentId, onOpenChange, openInApplication],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup aria-label="Open with">
        <Command>
          <CommandInput placeholder="Search installed applications…" />
          <CommandList>
            <CommandEmpty>{EMPTY_MESSAGE[state.kind]}</CommandEmpty>
            {state.kind === "loaded" &&
              state.applications.map((application) => (
                <CommandItem
                  key={application.id}
                  value={application.name}
                  onClick={() => pick(application.id)}
                >
                  {application.name}
                </CommandItem>
              ))}
          </CommandList>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
});
