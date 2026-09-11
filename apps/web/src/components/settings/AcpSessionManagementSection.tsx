import type {
  AcpRegistryConfigurableProvider,
  AcpRegistrySession,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

interface AcpSessionProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The ACP operation failed.",
  });
}

export function AcpSessionManagementSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly projects: ReadonlyArray<AcpSessionProject>;
  readonly readOnly: boolean;
}) {
  const [projectId, setProjectId] = useState<ProjectId | null>(props.projects[0]?.id ?? null);
  const [sessions, setSessions] = useState<ReadonlyArray<AcpRegistrySession>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [providers, setProviders] = useState<ReadonlyArray<AcpRegistryConfigurableProvider>>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<
    Readonly<Record<string, { apiType: string; baseUrl: string; headers: string }>>
  >({});
  const listSessions = useAtomCommand(serverEnvironment.listAcpRegistrySessions, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importAcpRegistrySession, {
    reportFailure: false,
  });
  const deleteSession = useAtomCommand(serverEnvironment.deleteAcpRegistrySession, {
    reportFailure: false,
  });
  const listProviders = useAtomCommand(serverEnvironment.listAcpRegistryProviders, {
    reportFailure: false,
  });
  const setProvider = useAtomCommand(serverEnvironment.setAcpRegistryProvider, {
    reportFailure: false,
  });
  const disableProvider = useAtomCommand(serverEnvironment.disableAcpRegistryProvider, {
    reportFailure: false,
  });
  const logout = useAtomCommand(serverEnvironment.logoutAcpRegistry, { reportFailure: false });
  const canList = props.provider.nativeSessions?.canList === true;
  const canImport =
    props.provider.nativeSessions?.canLoad === true ||
    props.provider.nativeSessions?.canResume === true;
  const canLogout = props.provider.auth.canLogout === true;
  const canDelete = props.provider.nativeSessions?.canDelete === true;
  const canConfigureProviders = props.provider.configurableProviders === true;
  const projectOperationPending =
    loading ||
    importingSessionId !== null ||
    deletingSessionId !== null ||
    loadingProviders ||
    savingProviderId !== null;

  if (!canList && !canLogout && !canConfigureProviders) return null;

  const loadSessions = async (cursor?: string) => {
    if (projectId === null || loading) return;
    setLoading(true);
    const result = await listSessions({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    setLoading(false);
    if (result._tag === "Success") {
      setSessions((current) =>
        cursor === undefined ? result.value.sessions : [...current, ...result.value.sessions],
      );
      setNextCursor(result.value.nextCursor);
      return;
    }
    reportFailure("Could not list ACP sessions", result);
  };

  const importNativeSession = async (session: AcpRegistrySession) => {
    if (projectId === null || importingSessionId !== null) return;
    setImportingSessionId(session.sessionId);
    const result = await importSession({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
    setImportingSessionId(null);
    if (result._tag === "Success") {
      setSessions((current) =>
        current.map((candidate) =>
          candidate.sessionId === session.sessionId
            ? { ...candidate, importedThreadId: result.value.threadId }
            : candidate,
        ),
      );
      toastManager.add({
        type: "success",
        title: result.value.imported ? "ACP session imported" : "ACP session already imported",
      });
      return;
    }
    reportFailure("Could not import ACP session", result);
  };

  const deleteNativeSession = async (session: AcpRegistrySession) => {
    if (projectId === null || deletingSessionId !== null || session.importedThreadId !== null)
      return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Permanently delete native ACP session "${session.title ?? session.sessionId}"?`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setDeletingSessionId(session.sessionId);
    const result = await deleteSession({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, projectId, sessionId: session.sessionId },
    });
    setDeletingSessionId(null);
    if (result._tag === "Success") {
      setSessions((current) =>
        current.filter((candidate) => candidate.sessionId !== session.sessionId),
      );
      toastManager.add({ type: "success", title: "ACP session deleted" });
      return;
    }
    reportFailure("Could not delete ACP session", result);
  };

  const loadProviders = async () => {
    if (projectId === null || loadingProviders) return;
    setLoadingProviders(true);
    const result = await listProviders({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, projectId },
    });
    setLoadingProviders(false);
    if (result._tag === "Success") {
      setProviders(result.value.providers);
      setProviderDrafts(
        Object.fromEntries(
          result.value.providers.map((provider) => [
            provider.providerId,
            {
              apiType: provider.current?.apiType ?? provider.supported[0] ?? "",
              baseUrl: provider.current?.baseUrl ?? "",
              headers: "",
            },
          ]),
        ),
      );
      return;
    }
    reportFailure("Could not list ACP providers", result);
  };

  const saveProvider = async (provider: AcpRegistryConfigurableProvider) => {
    if (projectId === null || savingProviderId !== null) return;
    const draft = providerDrafts[provider.providerId];
    if (draft === undefined || draft.apiType.length === 0 || draft.baseUrl.length === 0) return;
    let headers: Record<string, string> | undefined;
    if (draft.headers.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(draft.headers);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          !Object.values(parsed).every((value) => typeof value === "string")
        ) {
          throw new Error("Headers must be a JSON object with string values.");
        }
        headers = parsed as Record<string, string>;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Invalid provider headers",
          description: error instanceof Error ? error.message : "Headers must be valid JSON.",
        });
        return;
      }
    }
    setSavingProviderId(provider.providerId);
    const result = await setProvider({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        providerId: provider.providerId,
        apiType: draft.apiType,
        baseUrl: draft.baseUrl,
        ...(headers === undefined ? {} : { headers }),
      },
    });
    setSavingProviderId(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "ACP provider configured" });
      await loadProviders();
      return;
    }
    reportFailure("Could not configure ACP provider", result);
  };

  const disableConfiguredProvider = async (provider: AcpRegistryConfigurableProvider) => {
    if (projectId === null || savingProviderId !== null || provider.required) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Disable ACP provider "${provider.providerId}"?`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setSavingProviderId(provider.providerId);
    const result = await disableProvider({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, projectId, providerId: provider.providerId },
    });
    setSavingProviderId(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "ACP provider disabled" });
      await loadProviders();
      return;
    }
    reportFailure("Could not disable ACP provider", result);
  };

  const logoutProvider = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    const result = await logout({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    });
    setLoggingOut(false);
    if (result._tag === "Success") {
      setSessions([]);
      setNextCursor(null);
      toastManager.add({ type: "success", title: "Logged out of ACP agent" });
      return;
    }
    reportFailure("Could not log out of ACP agent", result);
  };

  return (
    <div className="grid gap-3 border-t border-border/60 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-foreground">Native sessions</p>
          <p className="text-xs text-muted-foreground">
            Resume agent-owned conversations as T3 threads.
          </p>
        </div>
        {canLogout ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={props.readOnly || loggingOut}
            onClick={() => void logoutProvider()}
          >
            {loggingOut ? "Logging out" : "Log out"}
          </Button>
        ) : null}
      </div>

      {canList ? (
        props.projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add a project on this device before importing native sessions.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={projectId ?? ""}
                disabled={props.readOnly || projectOperationPending}
                onValueChange={(value) => {
                  if (value === null) return;
                  setProjectId(value as ProjectId);
                  setSessions([]);
                  setNextCursor(null);
                  setProviders([]);
                  setProviderDrafts({});
                }}
              >
                <SelectTrigger aria-label="Project for ACP sessions" className="min-w-48" size="xs">
                  <SelectValue>
                    {props.projects.find((project) => project.id === projectId)?.title}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {props.projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={props.readOnly || loading || projectId === null}
                onClick={() => void loadSessions()}
              >
                {loading ? "Loading" : sessions.length === 0 ? "List sessions" : "Refresh"}
              </Button>
            </div>

            {sessions.length > 0 ? (
              <div className="divide-y divide-border/60 border-y border-border/60">
                {sessions.map((session) => (
                  <div
                    key={session.sessionId}
                    className="flex min-w-0 items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs text-foreground">
                        {session.title ?? session.sessionId}
                      </p>
                      <code className="block truncate text-[10px] text-muted-foreground">
                        {session.sessionId}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost-muted"
                        disabled={
                          props.readOnly ||
                          !canImport ||
                          session.importedThreadId !== null ||
                          importingSessionId !== null
                        }
                        onClick={() => void importNativeSession(session)}
                      >
                        {session.importedThreadId !== null
                          ? "Imported"
                          : importingSessionId === session.sessionId
                            ? "Importing"
                            : "Import"}
                      </Button>
                      {canDelete ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost-muted"
                          disabled={
                            props.readOnly ||
                            session.importedThreadId !== null ||
                            deletingSessionId !== null
                          }
                          onClick={() => void deleteNativeSession(session)}
                        >
                          {deletingSessionId === session.sessionId ? "Deleting" : "Delete"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {nextCursor !== null ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                className="w-fit"
                disabled={props.readOnly || loading}
                onClick={() => void loadSessions(nextCursor)}
              >
                {loading ? "Loading" : "Load more"}
              </Button>
            ) : null}
          </>
        )
      ) : null}

      {canConfigureProviders ? (
        <div className="grid gap-3 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-foreground">Agent providers</p>
              <p className="text-xs text-muted-foreground">
                Configure non-secret routing. Headers are write-only.
              </p>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={props.readOnly || loadingProviders || projectId === null}
              onClick={() => void loadProviders()}
            >
              {loadingProviders ? "Loading" : providers.length === 0 ? "List providers" : "Refresh"}
            </Button>
          </div>

          {!canList && props.projects.length > 1 ? (
            <Select
              value={projectId ?? ""}
              disabled={props.readOnly || projectOperationPending}
              onValueChange={(value) => {
                if (value === null) return;
                setProjectId(value as ProjectId);
                setProviders([]);
                setProviderDrafts({});
              }}
            >
              <SelectTrigger aria-label="Project for ACP providers" className="min-w-48" size="xs">
                <SelectValue>
                  {props.projects.find((project) => project.id === projectId)?.title}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {props.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}

          {providers.length > 0 ? (
            <div className="divide-y divide-border/60 border-y border-border/60">
              {providers.map((provider) => {
                const draft = providerDrafts[provider.providerId] ?? {
                  apiType: provider.current?.apiType ?? provider.supported[0] ?? "",
                  baseUrl: provider.current?.baseUrl ?? "",
                  headers: "",
                };
                const updateDraft = (update: Partial<typeof draft>) =>
                  setProviderDrafts((current) => ({
                    ...current,
                    [provider.providerId]: { ...draft, ...update },
                  }));
                return (
                  <div key={provider.providerId} className="grid gap-2 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">
                          {provider.providerId}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {provider.current === null ? "Disabled" : "Configured"}
                          {provider.required ? " · Required" : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={
                            props.readOnly ||
                            savingProviderId !== null ||
                            draft.apiType.length === 0 ||
                            draft.baseUrl.length === 0
                          }
                          onClick={() => void saveProvider(provider)}
                        >
                          {savingProviderId === provider.providerId ? "Saving" : "Save"}
                        </Button>
                        {!provider.required && provider.current !== null ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost-muted"
                            disabled={props.readOnly || savingProviderId !== null}
                            onClick={() => void disableConfiguredProvider(provider)}
                          >
                            Disable
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                      <Select
                        value={draft.apiType}
                        disabled={props.readOnly || savingProviderId !== null}
                        onValueChange={(value) => {
                          if (value !== null) updateDraft({ apiType: value });
                        }}
                      >
                        <SelectTrigger aria-label={`${provider.providerId} protocol`} size="sm">
                          <SelectValue>{draft.apiType}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {provider.supported.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>
                              {protocol}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <Input
                        size="sm"
                        type="url"
                        aria-label={`${provider.providerId} base URL`}
                        placeholder="https://api.example.com"
                        value={draft.baseUrl}
                        disabled={props.readOnly || savingProviderId !== null}
                        onValueChange={(value) => updateDraft({ baseUrl: value })}
                      />
                    </div>
                    <Input
                      size="sm"
                      type="password"
                      aria-label={`${provider.providerId} write-only headers JSON`}
                      placeholder='Write-only headers JSON, e.g. {"Authorization":"Bearer …"}'
                      value={draft.headers}
                      disabled={props.readOnly || savingProviderId !== null}
                      onValueChange={(value) => updateDraft({ headers: value })}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
