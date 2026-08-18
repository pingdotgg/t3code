import type {
  CustomEditor,
  EditorSelectionId,
  EnvironmentId,
  InstalledApplication,
} from "@t3tools/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { applicationInitialIcon } from "./applicationInitialIcon";
import {
  customEditorIdFor,
  filterApplications,
  forgetApplication,
  rememberApplication,
} from "./openWithApplications";

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly applications: ReadonlyArray<InstalledApplication> }
  | { readonly kind: "failed" };

/**
 * Lists the applications installed on the environment host and opens the
 * project in whichever one the user picks, the way a system "Open with"
 * chooser does. The pick is remembered so the application joins the Open menu.
 */
export const OpenWithDialog = memo(function OpenWithDialog({
  environmentId,
  open,
  onOpenChange,
  onLaunch,
}: {
  environmentId: EnvironmentId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (editor: EditorSelectionId) => void;
}) {
  const customEditors = useEnvironmentSettings(environmentId, (settings) => settings.customEditors);
  // The raw command rather than useUpdateEnvironmentSettings: launching has to
  // wait for the settings write to land, because the server resolves the
  // command for a chosen application from settings and would otherwise race
  // the write and report "unknown editor".
  const persistSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "server settings update",
  );
  const listApplications = useAtomCommand(shellEnvironment.listInstalledApplications, {
    reportFailure: false,
  });
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [query, setQuery] = useState("");

  // Scan on open rather than on mount: the dialog is mounted for the lifetime
  // of the picker, and a scan is only worth paying for when it is visible.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: "loading" });
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

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const applications = state.kind === "loaded" ? state.applications : [];
  const visible = useMemo(() => filterApplications(applications, query), [applications, query]);
  const rememberedIds = useMemo(
    () => new Set(customEditors.map((entry) => entry.id as string)),
    [customEditors],
  );

  const pick = useCallback(
    (application: InstalledApplication) => {
      const next: ReadonlyArray<CustomEditor> = rememberApplication(customEditors, application);
      onOpenChange(false);
      void persistSettings({
        environmentId,
        input: { patch: { customEditors: next } },
      }).then((result) => {
        if (result._tag !== "Success") return;
        onLaunch(customEditorIdFor(application));
      });
    },
    [customEditors, environmentId, onLaunch, onOpenChange, persistSettings],
  );

  const forget = useCallback(
    (application: InstalledApplication) => {
      void persistSettings({
        environmentId,
        input: {
          patch: {
            customEditors: forgetApplication(customEditors, customEditorIdFor(application)),
          },
        },
      });
    },
    [customEditors, environmentId, persistSettings],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Open with</DialogTitle>
          <DialogDescription>
            Choose an application installed on this environment. It opens the project folder and is
            added to the Open menu.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label="Search applications"
            autoFocus
            placeholder="Search applications"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="mt-3 max-h-72 overflow-y-auto">
            {state.kind === "loading" && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Looking for installed applications…
              </p>
            )}
            {state.kind === "failed" && (
              <p className="py-6 text-center text-sm text-destructive">
                Could not read the installed applications on this environment.
              </p>
            )}
            {state.kind === "loaded" && visible.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {applications.length === 0
                  ? "No installed applications found on this environment."
                  : "No applications match that search."}
              </p>
            )}
            <ul>
              {visible.map((application) => {
                const remembered = rememberedIds.has(customEditorIdFor(application));
                const ApplicationIcon = applicationInitialIcon(application.name);
                return (
                  <li key={application.id} className="flex items-center gap-1">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent/60"
                      type="button"
                      onClick={() => pick(application)}
                    >
                      <ApplicationIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{application.name}</span>
                      {remembered && (
                        <CheckIcon
                          aria-label="In the Open menu"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      )}
                    </button>
                    {/* Adding an application to the Open menu needs a way back
                        out, or the menu only ever grows. */}
                    {remembered && (
                      <Button
                        aria-label={`Remove ${application.name} from the Open menu`}
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => forget(application)}
                      >
                        <XIcon aria-hidden="true" className="size-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
