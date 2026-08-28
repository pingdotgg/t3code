import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { LinearProjectBinding } from "@t3tools/contracts";
import { useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";

import { usePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { issueTrackingEnvironment } from "../../state/issueTracking";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { LinearIcon } from "../Icons";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const UNMAPPED = "__unmapped__";
export type LinearProviderChange = "available" | "updated" | "unavailable";

export function LinearConnectionDialog({
  open,
  onOpenChange,
  onProviderChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProviderChanged: (change: LinearProviderChange) => void;
}) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const linearSettings = usePrimarySettings((settings) => settings.issueTracking.linear);
  const projectBindings = linearSettings.projectBindings;
  const connection = useEnvironmentQuery(
    !open || environmentId === null
      ? null
      : issueTrackingEnvironment.linearStatus({ environmentId, input: undefined }),
  );
  const connect = useAtomCommand(issueTrackingEnvironment.linearConnect, { reportFailure: false });
  const disconnect = useAtomCommand(issueTrackingEnvironment.linearDisconnect, {
    reportFailure: false,
  });
  const saveProjectBinding = useAtomCommand(issueTrackingEnvironment.linearSetProjectBinding, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<{
    credentialId: string | null;
    accountName: string;
  } | null>(null);
  const linear = connection.data;
  const accounts = linear?.accounts ?? [];
  const legacyServerConnected =
    linear?.status === "authenticated" && linear.hasStoredToken === true && accounts.length === 0;
  const legacyKeyNeedsRemoval =
    linear?.hasStoredToken === true && accounts.length === 0 && !legacyServerConnected;
  const environmentTokenConnected =
    linear?.environmentAccount?.status === "authenticated" ||
    (linear?.status === "authenticated" &&
      linear.hasStoredToken === false &&
      accounts.length === 0);
  const singleKeyTeamMode =
    linear?.environmentAccount !== undefined || environmentTokenConnected || legacyServerConnected;
  const hasCurrentProjectBinding = projects.some(
    (project) =>
      projectBindings[project.id] != null ||
      (projectBindings[project.id] === undefined &&
        linearSettings.projectTeams[project.id] !== undefined),
  );
  const teamOptions = accounts.flatMap((account) =>
    account.teams.map((team) => ({
      value: JSON.stringify([account.credentialId, team.key]),
      label: `${account.accountName} — ${team.name} (${team.key})`,
      binding: { credentialId: account.credentialId, teamKey: team.key },
    })),
  );
  const environmentTeamOptions = (
    singleKeyTeamMode ? (linear?.environmentAccount?.teams ?? linear?.teams ?? []) : []
  ).map((team) => ({
    value: team.key,
    label: `${linear?.environmentAccount?.accountName ?? linear?.accountName ?? "Linear"} — ${team.name} (${team.key})`,
  }));
  const projectHasSource = (projectId: (typeof projects)[number]["id"]) =>
    projectBindings[projectId] != null ||
    (projectBindings[projectId] === undefined &&
      linearSettings.projectTeams[projectId] !== undefined);

  async function runCommand(
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    after: () => void,
  ) {
    setBusy(true);
    setActionError(null);
    const commandResult = await action();
    setBusy(false);
    if (commandResult._tag === "Failure") {
      setActionError(formatEnvironmentQueryError(commandResult.cause));
      return;
    }
    after();
  }

  const setProjectBinding = (
    projectId: (typeof projects)[number]["id"],
    binding: LinearProjectBinding | null,
  ) => {
    if (environmentId === null) return;
    void runCommand(
      () =>
        saveProjectBinding({
          environmentId,
          input: { projectId, binding },
        }),
      () => {
        const wasAvailable = projects.some((project) => projectHasSource(project.id));
        const isAvailable = projects.some((project) =>
          project.id === projectId ? binding !== null : projectHasSource(project.id),
        );
        onProviderChanged(
          wasAvailable === isAvailable ? "updated" : isAvailable ? "available" : "unavailable",
        );
      },
    );
  };

  const setProjectTeam = (projectId: (typeof projects)[number]["id"], teamKey: string | null) => {
    if (environmentId === null) return;
    void runCommand(
      () =>
        linear?.environmentAccount === undefined
          ? updateSettings({
              environmentId,
              input: {
                patch: {
                  issueTracking: {
                    linear:
                      teamKey === null
                        ? { projectTeamsToDelete: [projectId] }
                        : {
                            projectBindingsToDelete: [projectId],
                            projectTeams: { [projectId]: teamKey },
                          },
                  },
                },
              },
            })
          : saveProjectBinding({
              environmentId,
              input: {
                projectId,
                binding: teamKey === null ? null : { teamKey },
              },
            }),
      () => {
        const wasAvailable = projects.some((project) => projectHasSource(project.id));
        const isAvailable = projects.some((project) =>
          project.id === projectId ? teamKey !== null : projectHasSource(project.id),
        );
        onProviderChanged(
          wasAvailable === isAvailable ? "updated" : isAvailable ? "available" : "unavailable",
        );
      },
    );
  };

  const error = actionError ?? connection.error;
  const closeDialog = (nextOpen: boolean) => {
    if (busy) return;
    setActionError(null);
    onOpenChange(nextOpen);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={closeDialog}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <LinearIcon className="size-4.5" />
              Linear
            </DialogTitle>
            <DialogDescription>
              Add personal API keys, then choose the Linear account and team for each T3 project.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (environmentId === null || token.trim().length === 0 || legacyKeyNeedsRemoval)
                  return;
                void runCommand(
                  () => connect({ environmentId, input: { token: token.trim(), mode: "add" } }),
                  () => {
                    setToken("");
                    connection.refresh();
                    onProviderChanged("updated");
                  },
                );
              }}
            >
              <label className="block text-sm font-medium" htmlFor="linear-api-key">
                Add API key
              </label>
              <div className="flex gap-2">
                <Input
                  id="linear-api-key"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.currentTarget.value)}
                  placeholder="lin_api_…"
                  aria-label="Linear API key"
                  autoComplete="off"
                  disabled={busy || legacyKeyNeedsRemoval}
                />
                <Button
                  type="submit"
                  disabled={busy || token.trim().length === 0 || legacyKeyNeedsRemoval}
                >
                  Add
                </Button>
              </div>
            </form>

            {legacyKeyNeedsRemoval ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">Saved API key needs attention</p>
                  <p className="text-xs text-muted-foreground">
                    Disconnect it before you add another key.
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy}
                  aria-label="Disconnect saved Linear API key"
                  onClick={() =>
                    setPendingDisconnect({ credentialId: null, accountName: "saved API key" })
                  }
                >
                  Disconnect
                </Button>
              </div>
            ) : null}

            {legacyServerConnected ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {linear.accountName ?? "Linear account"}
                  </p>
                  <p className="text-xs text-muted-foreground">Connected with one saved key.</p>
                </div>
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy}
                  aria-label="Disconnect saved Linear API key"
                  onClick={() =>
                    setPendingDisconnect({
                      credentialId: null,
                      accountName: linear.accountName ?? "saved API key",
                    })
                  }
                >
                  Disconnect
                </Button>
              </div>
            ) : null}

            {accounts.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Saved accounts</h3>
                <div className="space-y-2">
                  {accounts.map((account) => (
                    <div key={account.credentialId} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{account.accountName}</p>
                          {account.accountEmail ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {account.accountEmail}
                            </p>
                          ) : null}
                          {account.status !== "authenticated" ? (
                            <p className="text-xs text-destructive">Needs attention</p>
                          ) : null}
                        </div>
                        <Button
                          size="xs"
                          variant="destructive-outline"
                          disabled={busy}
                          aria-label={`Disconnect ${account.accountName} from Linear`}
                          onClick={() =>
                            setPendingDisconnect({
                              credentialId: account.credentialId,
                              accountName: account.accountName,
                            })
                          }
                        >
                          Disconnect
                        </Button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                        {account.teams.length === 0
                          ? "No teams available."
                          : account.teams.map((team) => (
                              <span key={team.id} className="rounded-md bg-muted px-1.5 py-0.5">
                                {team.name} ({team.key})
                              </span>
                            ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {accounts.length > 0 || hasCurrentProjectBinding || singleKeyTeamMode ? (
              <div className="space-y-2">
                <div>
                  <h3 className="text-sm font-medium">Project connections</h3>
                  <p className="text-xs text-muted-foreground">
                    Choose the Linear account and team for each T3 project.
                  </p>
                </div>
                <div className="divide-y divide-border/50">
                  {projects.map((project) => {
                    const binding = projectBindings[project.id];
                    const options = [...environmentTeamOptions, ...teamOptions];
                    const value = binding
                      ? JSON.stringify([binding.credentialId, binding.teamKey])
                      : binding === undefined && singleKeyTeamMode
                        ? (linearSettings.projectTeams[project.id] ?? UNMAPPED)
                        : UNMAPPED;
                    const selectedOption = options.find((option) => option.value === value);
                    const bindingUnavailable = value !== UNMAPPED && selectedOption === undefined;
                    const selectedLabel = bindingUnavailable
                      ? "Needs attention"
                      : (selectedOption?.label ?? "Not connected");
                    return (
                      <div
                        key={project.id}
                        className="flex items-center justify-between gap-4 py-2"
                      >
                        <span className="min-w-0 truncate text-sm">{project.title}</span>
                        <Select
                          value={value}
                          disabled={busy}
                          onValueChange={(next) => {
                            if (!next) return;
                            if (next === UNMAPPED) {
                              if (binding) setProjectBinding(project.id, null);
                              else setProjectTeam(project.id, null);
                              return;
                            }
                            if (environmentTeamOptions.some((option) => option.value === next)) {
                              setProjectTeam(project.id, next);
                              return;
                            }
                            setProjectBinding(
                              project.id,
                              teamOptions.find((option) => option.value === next)?.binding ?? null,
                            );
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-64"
                            aria-label={`Linear account and team for ${project.title}`}
                            aria-invalid={bindingUnavailable || undefined}
                          >
                            <SelectValue>{selectedLabel}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            <SelectItem value={UNMAPPED}>Not connected</SelectItem>
                            {bindingUnavailable ? (
                              <SelectItem value={value} disabled>
                                Unavailable account or team
                              </SelectItem>
                            ) : null}
                            {options.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                    );
                  })}
                  {projects.length === 0 ? (
                    <p className="py-3 text-sm text-muted-foreground">Add a project first.</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => closeDialog(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={pendingDisconnect !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) {
            setPendingDisconnect(null);
            setActionError(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {pendingDisconnect?.accountName ?? "account"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes this API key. All T3 projects linked to this account will lose Linear
              access.
            </AlertDialogDescription>
            {actionError && pendingDisconnect ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || environmentId === null || pendingDisconnect === null}
              onClick={() => {
                if (environmentId === null || pendingDisconnect === null) return;
                const { credentialId } = pendingDisconnect;
                return runCommand(
                  () =>
                    disconnect({
                      environmentId,
                      input: credentialId === null ? undefined : { credentialId },
                    }),
                  () => {
                    setToken("");
                    setPendingDisconnect(null);
                    connection.refresh();
                    const wasAvailable = projects.some((project) => projectHasSource(project.id));
                    const isAvailable =
                      credentialId !== null &&
                      projects.some((project) => {
                        const binding = projectBindings[project.id];
                        return binding?.credentialId === credentialId
                          ? false
                          : projectHasSource(project.id);
                      });
                    onProviderChanged(wasAvailable && !isAvailable ? "unavailable" : "updated");
                  },
                );
              }}
            >
              {pendingDisconnect?.credentialId === null
                ? "Disconnect saved key"
                : "Disconnect account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
