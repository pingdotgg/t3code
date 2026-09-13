import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { LinearProjectBinding } from "@t3tools/contracts";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { issueTrackingEnvironment } from "../../state/issueTracking";
import { issueEnvironment } from "../../state/issues";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinearIcon } from "../Icons";
import { LinearConnectionDialog } from "../issue/LinearConnectionDialog";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const UNMAPPED = "__unmapped__";

export function LinearIntegrationSettings() {
  const environment = usePrimaryEnvironment();
  const supported = environment?.serverConfig?.environment.capabilities.issues === true;
  const environmentId = supported ? environment.environmentId : null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const linearSettings = usePrimarySettings((settings) => settings.issueTracking.linear);
  const projectBindings = linearSettings.projectBindings;
  const connection = useEnvironmentQuery(
    environmentId === null
      ? null
      : issueTrackingEnvironment.linearStatus({ environmentId, input: undefined }),
  );
  const disconnect = useAtomCommand(issueTrackingEnvironment.linearDisconnect, {
    reportFailure: false,
  });
  const saveProjectBinding = useAtomCommand(issueTrackingEnvironment.linearSetProjectBinding, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const invalidate = useAtomCommand(issueEnvironment.invalidate);
  const refreshIssues = () => {
    if (environmentId !== null) void invalidate({ environmentId, input: {} });
  };
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
      refreshIssues,
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
      refreshIssues,
    );
  };

  const error = actionError ?? connection.error;

  return (
    <>
      <SettingsSection id="linear" title="Issue Tracking">
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              <LinearIcon className="size-4" />
              Linear accounts
            </span>
          }
          description={
            supported ? undefined : "Connect to a server that supports issues to set up Linear."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!supported || busy || connection.isPending || legacyKeyNeedsRemoval}
              onClick={() => setAddAccountOpen(true)}
            >
              <PlusIcon />
              Add account
            </Button>
          }
        >
          {supported &&
          (error ||
            connection.isPending ||
            accounts.length > 0 ||
            singleKeyTeamMode ||
            legacyKeyNeedsRemoval) ? (
            <div className="space-y-2 py-3">
              {error && !pendingDisconnect ? (
                <div className="flex items-center justify-between gap-3">
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                  {connection.error ? (
                    <Button size="xs" variant="outline" onClick={connection.refresh}>
                      Retry
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {connection.isPending && !linear ? (
                <p className="text-sm text-muted-foreground">Loading Linear accounts…</p>
              ) : null}
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
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {linear.accountName ?? "Linear account"}
                    </span>
                    <RedactedSensitiveText
                      value={linear.accountEmail}
                      ariaLabel="Toggle Linear account email visibility"
                      revealTooltip="Click to reveal email"
                      hideTooltip="Click to hide email"
                      className="max-w-full truncate"
                    />
                    <span className="truncate text-xs text-muted-foreground">Saved key</span>
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

              {accounts.map((account) => (
                <div
                  key={account.credentialId}
                  className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-sm font-medium">{account.accountName}</span>
                    <RedactedSensitiveText
                      value={account.accountEmail}
                      ariaLabel="Toggle Linear account email visibility"
                      revealTooltip="Click to reveal email"
                      hideTooltip="Click to hide email"
                      className="max-w-full truncate"
                    />
                    {account.status !== "authenticated" ? (
                      <span className="truncate text-xs text-destructive">Needs attention</span>
                    ) : null}
                    <span className="truncate text-xs text-muted-foreground">
                      {account.teams.map((team) => `${team.name} (${team.key})`).join(", ")}
                    </span>
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
              ))}

              {environmentTokenConnected || linear?.environmentAccount ? (
                <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
                  <span className="truncate text-sm font-medium">
                    {linear?.environmentAccount?.accountName ??
                      linear?.accountName ??
                      "Linear account"}
                  </span>
                  <RedactedSensitiveText
                    value={
                      linear?.environmentAccount
                        ? linear.environmentAccount.accountEmail
                        : linear?.accountEmail
                    }
                    ariaLabel="Toggle Linear account email visibility"
                    revealTooltip="Click to reveal email"
                    hideTooltip="Click to hide email"
                    className="max-w-full truncate"
                  />
                  <span className="truncate text-xs text-muted-foreground">
                    Configured on server
                  </span>
                  {!environmentTokenConnected ? (
                    <span className="truncate text-xs text-destructive">Needs attention</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
        {supported && (accounts.length > 0 || hasCurrentProjectBinding || singleKeyTeamMode) ? (
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-3 text-sm font-medium sm:px-4">
              <span className="flex min-w-0 items-center gap-2 text-left group-data-panel-open:flex-col group-data-panel-open:items-start group-data-panel-open:gap-1">
                <span className="shrink-0">Project connections</span>
                <span className="truncate text-[13px] font-normal text-muted-foreground/80 group-data-panel-open:whitespace-normal">
                  Choose the Linear account and team for each T3 project.
                </span>
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:mt-0.5 group-data-panel-open:rotate-90 group-data-panel-open:self-start" />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="px-3 pb-1 sm:px-4">
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
                        className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
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
                            className="w-full sm:w-64"
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
            </CollapsiblePanel>
          </Collapsible>
        ) : null}
      </SettingsSection>
      {addAccountOpen && environmentId !== null && !legacyKeyNeedsRemoval ? (
        <LinearConnectionDialog
          key={environmentId}
          open={addAccountOpen}
          environmentId={environmentId}
          onOpenChange={setAddAccountOpen}
          onConnected={() => {
            connection.refresh();
            refreshIssues();
          }}
        />
      ) : null}
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
                    setPendingDisconnect(null);
                    connection.refresh();
                    refreshIssues();
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
