import { ArrowLeftIcon, ExternalLinkIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useCanGoBack, useNavigate } from "@tanstack/react-router";
import type {
  ProjectEffectiveRemote,
  ProjectRemoteOverride,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ensureEnvironmentApi } from "../environmentApi";
import { cn, newCommandId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Switch } from "../components/ui/switch";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { toastManager, stackedThreadToast } from "../components/ui/toast";
import { isElectron } from "../env";

const PROVIDER_LABELS: Record<SourceControlProviderKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  "azure-devops": "Azure DevOps",
  bitbucket: "Bitbucket",
  unknown: "Generic",
};

function projectDetailsQueryKey(environmentId: string | undefined, projectId: string) {
  return ["project-details", environmentId ?? "missing", projectId] as const;
}

function ProjectRouteView() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const queryClient = useQueryClient();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const project = projects.find((candidate) => candidate.id === projectId);
  const queryKey = projectDetailsQueryKey(project?.environmentId, projectId);

  const projectDetails = useQuery({
    queryKey,
    enabled: project !== undefined,
    queryFn: () =>
      ensureEnvironmentApi(project!.environmentId).projects.getDetails({
        projectId: project!.id,
      }),
  });

  const [title, setTitle] = useState("");
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [provider, setProvider] = useState<SourceControlProviderKind>("gitlab");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [webUrl, setWebUrl] = useState("");

  useEffect(() => {
    const details = projectDetails.data;
    if (!details) return;
    const override = details.settings.remoteOverride;
    setTitle(details.title);
    setOverrideEnabled(Boolean(override));
    setProvider(override?.provider ?? details.detected.primaryRemote?.provider?.kind ?? "gitlab");
    setRemoteUrl(override?.remoteUrl ?? details.detected.primaryRemote?.url ?? "");
    setWebUrl(override?.webUrl ?? details.detected.primaryRemote?.provider?.baseUrl ?? "");
  }, [projectDetails.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!project || !projectDetails.data) return;
      const api = ensureEnvironmentApi(project.environmentId);
      const trimmedTitle = title.trim();
      if (trimmedTitle.length === 0) {
        throw new Error("Project name cannot be empty.");
      }

      if (trimmedTitle !== projectDetails.data.title) {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: project.id,
          title: trimmedTitle,
        });
      }

      const trimmedRemoteUrl = remoteUrl.trim();
      const trimmedWebUrl = webUrl.trim();
      const remoteOverride: ProjectRemoteOverride | null = overrideEnabled
        ? {
            provider,
            remoteUrl: trimmedRemoteUrl,
            ...(trimmedWebUrl ? { webUrl: trimmedWebUrl } : {}),
          }
        : null;

      if (overrideEnabled && trimmedRemoteUrl.length === 0) {
        throw new Error("Remote URL is required when manual remote override is enabled.");
      }

      await api.projects.updateSettings({
        projectId: project.id,
        patch: {
          remoteOverride,
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      toastManager.add({
        type: "success",
        title: "Project settings saved",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to save project settings",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const navigateBackWithinApp = () => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  };

  const effectiveRemote = projectDetails.data?.effective.remote ?? null;
  const detectedPrimaryRemote = projectDetails.data?.detected.primaryRemote ?? null;
  const hasChanges = useMemo(() => {
    const details = projectDetails.data;
    if (!details) return false;
    const override = details.settings.remoteOverride;
    return (
      title.trim() !== details.title ||
      overrideEnabled !== Boolean(override) ||
      (overrideEnabled &&
        (provider !== (override?.provider ?? "gitlab") ||
          remoteUrl.trim() !== (override?.remoteUrl ?? "") ||
          webUrl.trim() !== (override?.webUrl ?? "")))
    );
  }, [overrideEnabled, projectDetails.data, provider, remoteUrl, title, webUrl]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <Button
            size="icon-xs"
            variant="ghost"
            className={isElectron ? "drag-region-none" : ""}
            aria-label="Back"
            onClick={navigateBackWithinApp}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">Project settings</div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={projectDetails.isFetching}
            onClick={() => void projectDetails.refetch()}
          >
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
          <Button
            size="sm"
            disabled={!hasChanges || saveMutation.isPending || projectDetails.isLoading}
            onClick={() => saveMutation.mutate()}
          >
            <SaveIcon className="size-3.5" />
            Save
          </Button>
        </header>

        <SettingsPageContainer>
          {!project ? (
            <ProjectNotice title="Project not found" description="This project is not loaded." />
          ) : projectDetails.isLoading ? (
            <ProjectNotice title="Loading project" description={project.cwd} />
          ) : projectDetails.isError ? (
            <ProjectNotice
              title="Unable to load project"
              description={
                projectDetails.error instanceof Error
                  ? projectDetails.error.message
                  : "Project details could not be loaded."
              }
            />
          ) : projectDetails.data ? (
            <>
              <section className="space-y-2">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h1 className="truncate text-2xl font-semibold tracking-tight">
                      {projectDetails.data.effective.title}
                    </h1>
                  </div>
                </div>
              </section>

              <SettingsSection title="Project">
                <ProjectSettingRow
                  title="Name"
                  control={
                    <Input
                      className="max-w-md"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  }
                />
                <ProjectSettingRow title="Path" value={projectDetails.data.workspaceRoot} />
              </SettingsSection>

              <SettingsSection
                title="Git info"
                headerAction={
                  effectiveRemote?.webUrl ? <OpenRemoteButton remote={effectiveRemote} /> : null
                }
              >
                <ProjectSettingRow
                  title="Manual remote"
                  control={
                    <Switch
                      checked={overrideEnabled}
                      onCheckedChange={(checked) => setOverrideEnabled(checked)}
                    />
                  }
                >
                  {overrideEnabled ? (
                    <div className="grid gap-3 border-t border-border/60 pt-4 md:grid-cols-[12rem_minmax(0,1fr)]">
                      <label className="grid gap-1.5 text-xs font-medium text-foreground">
                        Provider
                        <Select
                          value={provider}
                          onValueChange={(value) => setProvider(value as SourceControlProviderKind)}
                        >
                          <SelectTrigger aria-label="Source control provider">
                            <SelectValue>{PROVIDER_LABELS[provider]}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="start">
                            {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </label>
                      <label className="grid gap-1.5 text-xs font-medium text-foreground">
                        Remote URL
                        <Input
                          value={remoteUrl}
                          placeholder="git@git.example.com:team/repo.git"
                          onChange={(event) => setRemoteUrl(event.target.value)}
                        />
                      </label>
                      <div className="hidden md:block" />
                      <label className="grid gap-1.5 text-xs font-medium text-foreground">
                        Web URL
                        <Input
                          value={webUrl}
                          placeholder="https://git.example.com/team/repo"
                          onChange={(event) => setWebUrl(event.target.value)}
                        />
                      </label>
                    </div>
                  ) : null}
                </ProjectSettingRow>
                <ProjectSettingRow
                  title="Detected remote"
                  value={
                    detectedPrimaryRemote ? detectedPrimaryRemote.url : "No Git remote detected."
                  }
                />
                <ProjectSettingRow
                  title="Effective remote"
                  value={
                    effectiveRemote ? effectiveRemote.remoteUrl : "No effective remote configured."
                  }
                />
                <ProjectSettingRow
                  title="Repository root"
                  value={projectDetails.data.detected.gitRoot ?? "Not inside a Git repository."}
                />
                <ProjectSettingRow
                  title="Branch"
                  value={projectDetails.data.detected.branch ?? "Detached or unavailable."}
                />
              </SettingsSection>
            </>
          ) : null}
        </SettingsPageContainer>
      </div>
    </SidebarInset>
  );
}

function ProjectSettingRow({
  title,
  value,
  control,
  children,
}: {
  title: string;
  value?: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const hasChildren = Boolean(children);
  return (
    <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-between sm:gap-6",
          hasChildren ? "sm:items-start" : "sm:items-center",
        )}
      >
        <div
          className={cn(
            "shrink-0 text-sm font-medium text-foreground sm:min-w-48",
            hasChildren && "sm:pt-1.5",
          )}
        >
          {title}
        </div>
        <div className="min-w-0 sm:flex-1">
          {control ? (
            <div className="flex min-w-0 items-center sm:justify-end">{control}</div>
          ) : (
            <div
              className="min-w-0 truncate text-sm text-muted-foreground sm:text-right"
              title={value}
            >
              {value}
            </div>
          )}
          {children ? <div className="mt-4 min-w-0">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}

function ProjectNotice({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-card-foreground">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function OpenRemoteButton({ remote }: { remote: ProjectEffectiveRemote }) {
  const openRemote = () => {
    const url = remote.webUrl ?? remote.providerInfo?.baseUrl;
    if (!url) return;
    const api = readLocalApi();
    void api?.shell.openExternal(url).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open remote",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };
  return (
    <Button size="xs" variant="ghost" onClick={openRemote}>
      <ExternalLinkIcon className="size-3.5" />
      Open
    </Button>
  );
}

export const Route = createFileRoute("/projects/$projectId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ProjectRouteView,
});
