import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProjectId,
  RemoteHostId,
  type RemoteHostRecord,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { newCommandId, newProjectId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import type { Project } from "../types";
import { toastManager } from "./ui/toast";
import { projectTitleFromPath } from "./Sidebar.helpers";
import {
  REMOTE_BROWSE_LIMIT,
  REMOTE_HOSTS_QUERY_KEY,
  type RemoteHostDraft,
  doesRemoteHostDraftMatchRecord,
  draftFromRemoteHost,
  emptyRemoteHostDraft,
  remoteHostDraftToUpsertInput,
} from "./Sidebar.remoteHosts";

interface UseSidebarProjectActionsInput {
  readonly projects: readonly Project[];
  readonly focusMostRecentThreadForProject: (projectId: ProjectId) => void;
  readonly handleNewThread: (projectId: ProjectId) => Promise<void>;
}

interface RemoteBrowseEntry {
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly parentPath?: string | undefined;
}

export function useSidebarProjectActions({
  projects,
  focusMostRecentThreadForProject,
  handleNewThread,
}: UseSidebarProjectActionsInput) {
  const queryClient = useQueryClient();
  const [addingProject, setAddingProject] = useState(false);
  const [addProjectMode, setAddProjectMode] = useState<"local" | "remote">("local");
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [selectedRemoteHostId, setSelectedRemoteHostId] = useState<RemoteHostId | null>(null);
  const [isCreatingRemoteHost, setIsCreatingRemoteHost] = useState(false);
  const [remoteHostDraft, setRemoteHostDraft] = useState<RemoteHostDraft>(() =>
    emptyRemoteHostDraft(),
  );
  const [remotePath, setRemotePath] = useState("");
  const [remoteBrowseQuery, setRemoteBrowseQuery] = useState("");
  const [remoteHostDialogOpen, setRemoteHostDialogOpen] = useState(false);

  const { data: remoteHosts = [] } = useQuery({
    queryKey: REMOTE_HOSTS_QUERY_KEY,
    queryFn: async () => {
      const api = readNativeApi();
      if (!api) return [];
      return api.remoteHosts.list();
    },
    enabled: addingProject && addProjectMode === "remote",
    staleTime: 15_000,
  });

  const selectedRemoteHost = useMemo(
    () => remoteHosts.find((host) => host.id === selectedRemoteHostId) ?? null,
    [remoteHosts, selectedRemoteHostId],
  );

  const saveRemoteHostMutation = useMutation({
    mutationFn: async (draft: RemoteHostDraft) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API unavailable.");
      }
      return api.remoteHosts.upsert(remoteHostDraftToUpsertInput(draft));
    },
    onSuccess: async (host) => {
      setIsCreatingRemoteHost(false);
      setSelectedRemoteHostId(host.id);
      setRemoteHostDraft(draftFromRemoteHost(host));
      await queryClient.invalidateQueries({ queryKey: REMOTE_HOSTS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: "Saved remote host",
        description: host.label,
      });
    },
  });

  const testRemoteHostMutation = useMutation({
    mutationFn: async (remoteHostId: RemoteHostId) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API unavailable.");
      }
      return api.remoteHosts.testConnection({ remoteHostId });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: REMOTE_HOSTS_QUERY_KEY });
      toastManager.add({
        type: result.ok ? "success" : "error",
        title: result.ok ? "Remote host connected" : "Remote host unavailable",
        description:
          result.helperVersion !== null
            ? `Helper ${result.helperVersion}`
            : (result.message ?? "Connection test completed."),
      });
    },
  });

  const browseRemoteHostMutation = useMutation({
    mutationFn: async (input: { remoteHostId: RemoteHostId; path?: string; query?: string }) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API unavailable.");
      }
      return api.remoteHosts.browse({
        remoteHostId: input.remoteHostId,
        ...(input.path?.trim() ? { path: input.path.trim() } : {}),
        ...(input.query?.trim() ? { query: input.query.trim() } : {}),
        limit: REMOTE_BROWSE_LIMIT,
      });
    },
  });

  const removeRemoteHostMutation = useMutation({
    mutationFn: async (remoteHostId: RemoteHostId) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API unavailable.");
      }
      await api.remoteHosts.remove({ remoteHostId });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: REMOTE_HOSTS_QUERY_KEY });
      setIsCreatingRemoteHost(true);
      setSelectedRemoteHostId(null);
      setRemoteHostDraft(emptyRemoteHostDraft());
      browseRemoteHostMutation.reset();
      toastManager.add({
        type: "success",
        title: "Remote host removed",
      });
    },
  });

  const handleRemoteHostSelect = useCallback(
    (remoteHostId: RemoteHostId | null) => {
      setIsCreatingRemoteHost(remoteHostId === null);
      setSelectedRemoteHostId(remoteHostId);
      const nextHost = remoteHosts.find((host) => host.id === remoteHostId) ?? null;
      setRemoteHostDraft(nextHost ? draftFromRemoteHost(nextHost) : emptyRemoteHostDraft());
      browseRemoteHostMutation.reset();
    },
    [browseRemoteHostMutation, remoteHosts],
  );

  const handleCreateRemoteHost = useCallback(() => {
    setIsCreatingRemoteHost(true);
    setSelectedRemoteHostId(null);
    setRemoteHostDraft(emptyRemoteHostDraft());
    browseRemoteHostMutation.reset();
  }, [browseRemoteHostMutation]);

  const handleSaveRemoteHost = useCallback(() => {
    void saveRemoteHostMutation.mutateAsync(remoteHostDraft).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Could not save remote host",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    });
  }, [remoteHostDraft, saveRemoteHostMutation]);

  const ensureSavedRemoteHost = useCallback(async (): Promise<RemoteHostRecord> => {
    if (selectedRemoteHost && doesRemoteHostDraftMatchRecord(remoteHostDraft, selectedRemoteHost)) {
      return selectedRemoteHost;
    }
    return saveRemoteHostMutation.mutateAsync(remoteHostDraft);
  }, [remoteHostDraft, saveRemoteHostMutation, selectedRemoteHost]);

  const addLocalProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddingProject(false);
      };

      const existing = projects.find(
        (project) => project.executionTarget === "local" && project.cwd === cwd,
      );
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title: projectTitleFromPath(cwd),
          workspaceRoot: cwd,
          executionTarget: "local",
          remoteHostId: null,
          remoteHostLabel: null,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt,
        });
        await handleNewThread(projectId).catch(() => undefined);
      } catch (error) {
        setIsAddingProject(false);
        toastManager.add({
          type: "error",
          title: "Unable to add project",
          description:
            error instanceof Error ? error.message : "An error occurred while adding the project.",
        });
        return;
      }
      finishAddingProject();
    },
    [focusMostRecentThreadForProject, handleNewThread, isAddingProject, projects],
  );

  const addRemoteProjectFromPath = useCallback(
    async (rawPath: string) => {
      const api = readNativeApi();
      const requestedWorkspaceRoot = rawPath.trim();
      if (!api || !requestedWorkspaceRoot || isAddingProject) {
        return;
      }

      let savedRemoteHost: RemoteHostRecord;
      try {
        savedRemoteHost = await ensureSavedRemoteHost();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not save remote host",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
        return;
      }

      let workspaceRoot = requestedWorkspaceRoot;
      try {
        const browseResult = await api.remoteHosts.browse({
          remoteHostId: savedRemoteHost.id,
          path: requestedWorkspaceRoot,
          limit: 1,
        });
        workspaceRoot = browseResult.cwd;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Remote workspace path is unavailable",
          description:
            error instanceof Error
              ? error.message
              : "The remote workspace path does not exist or is not accessible.",
        });
        return;
      }

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setRemotePath("");
        setRemoteBrowseQuery("");
        browseRemoteHostMutation.reset();
        setAddingProject(false);
      };

      const existing = projects.find(
        (project) =>
          project.executionTarget === "ssh-remote" &&
          project.remoteHostId === savedRemoteHost.id &&
          project.cwd === workspaceRoot,
      );
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title: projectTitleFromPath(workspaceRoot),
          workspaceRoot,
          executionTarget: "ssh-remote",
          remoteHostId: savedRemoteHost.id,
          remoteHostLabel: savedRemoteHost.label,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt,
        });
        await handleNewThread(projectId).catch(() => undefined);
      } catch (error) {
        setIsAddingProject(false);
        toastManager.add({
          type: "error",
          title: "Unable to add remote project",
          description:
            error instanceof Error ? error.message : "An error occurred while adding the project.",
        });
        return;
      }
      finishAddingProject();
    },
    [
      browseRemoteHostMutation,
      ensureSavedRemoteHost,
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
    ],
  );

  const handleAddProject = useCallback(() => {
    if (addProjectMode === "remote") {
      void addRemoteProjectFromPath(remotePath);
      return;
    }
    void addLocalProjectFromPath(newCwd);
  }, [addLocalProjectFromPath, addProjectMode, addRemoteProjectFromPath, newCwd, remotePath]);

  const handleTestRemoteHost = useCallback(() => {
    void ensureSavedRemoteHost()
      .then((host) => testRemoteHostMutation.mutateAsync(host.id))
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Remote host connection failed",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      });
  }, [ensureSavedRemoteHost, testRemoteHostMutation]);

  const handleBrowseRemotePath = useCallback(
    (pathOverride?: string) => {
      void ensureSavedRemoteHost()
        .then((host) =>
          browseRemoteHostMutation.mutateAsync({
            remoteHostId: host.id,
            path: pathOverride ?? remotePath,
            query: remoteBrowseQuery,
          }),
        )
        .then((result) => {
          setRemotePath(result.cwd);
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Unable to browse remote path",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    },
    [browseRemoteHostMutation, ensureSavedRemoteHost, remoteBrowseQuery, remotePath],
  );

  const handlePickFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addLocalProjectFromPath(pickedPath);
    }
    setIsPickingFolder(false);
  }, [addLocalProjectFromPath, isPickingFolder]);

  const handleRemoveRemoteHost = useCallback(
    (remoteHostId: RemoteHostId) => {
      void removeRemoteHostMutation.mutateAsync(remoteHostId).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not remove remote host",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      });
    },
    [removeRemoteHostMutation],
  );

  const resetAddProjectDialog = useCallback(() => {
    setAddingProject(false);
    setAddProjectMode("local");
    setNewCwd("");
    setIsCreatingRemoteHost(false);
    setRemotePath("");
    setRemoteBrowseQuery("");
    browseRemoteHostMutation.reset();
  }, [browseRemoteHostMutation]);

  const handleSelectRemoteBrowseEntry = useCallback(
    (entry: RemoteBrowseEntry) => {
      const nextPath =
        entry.kind === "directory" ? entry.path : (entry.parentPath ?? entry.path);
      setRemotePath(nextPath);
      if (entry.kind === "directory") {
        handleBrowseRemotePath(entry.path);
      }
    },
    [handleBrowseRemotePath],
  );

  useEffect(() => {
    if (!addingProject || addProjectMode !== "remote") {
      return;
    }
    if (selectedRemoteHostId || isCreatingRemoteHost) {
      return;
    }
    const firstHost = remoteHosts[0];
    if (!firstHost) {
      return;
    }
    setSelectedRemoteHostId(firstHost.id);
    setRemoteHostDraft(draftFromRemoteHost(firstHost));
  }, [addProjectMode, addingProject, isCreatingRemoteHost, remoteHosts, selectedRemoteHostId]);

  return {
    addingProject,
    setAddingProject,
    addProjectMode,
    setAddProjectMode,
    newCwd,
    setNewCwd,
    isPickingFolder,
    isAddingProject,
    handlePickFolder,
    selectedRemoteHostId,
    remoteHosts,
    selectedRemoteHost,
    handleRemoteHostSelect,
    handleCreateRemoteHost,
    remoteHostDraft,
    setRemoteHostDraft,
    remotePath,
    setRemotePath,
    remoteBrowseQuery,
    setRemoteBrowseQuery,
    handleBrowseRemotePath,
    browseRemoteHostData: browseRemoteHostMutation.data,
    isBrowsingRemotePath: browseRemoteHostMutation.isPending,
    handleAddProject,
    resetAddProjectDialog,
    handleSelectRemoteBrowseEntry,
    remoteHostDialogOpen,
    setRemoteHostDialogOpen,
    handleSaveRemoteHost,
    handleTestRemoteHost,
    handleRemoveRemoteHost,
    isSavingRemoteHost: saveRemoteHostMutation.isPending,
    isTestingRemoteHost: testRemoteHostMutation.isPending,
    isRemovingRemoteHost: removeRemoteHostMutation.isPending,
  };
}
