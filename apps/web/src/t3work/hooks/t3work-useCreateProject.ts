import { useCallback, useState } from "react";
import * as Effect from "effect/Effect";
import { resolveT3WorkProjectSetupProfileId } from "~/t3work/t3work-projectSetup";
import type {
  AtlassianAccessibleResource,
  TokenExchangeResult,
} from "@t3tools/integrations-atlassian";
import type { ExternalProject, IntegrationAccount } from "@t3tools/integrations-core";
import type { ProjectShellProject } from "@t3tools/project-context";
import { useBackend } from "~/t3work/backend/t3work-index";
import { t3workCreateProject } from "~/t3work/t3work-mock-adapter";
import { buildInitialRaw, normalizeRepositoryUrls } from "./t3work-createProjectBootstrap";
import { finalizeCreatedProject } from "./t3work-createProjectFinalization";
import { isValidAtlassianUrl, normalizeAtlassianUrl } from "./t3work-createProjectUtils";
import { writeIntegrationCache } from "./t3work-integrationCache";
import { readT3workProjectSetupProfile } from "~/t3work/t3work-projectSetupProfile";
import type { T3WorkProfile } from "@t3tools/t3work-skill-packs";
import { loadProjectsForAccount } from "./t3work-useCreateProjectAccountLoaders";
import { applyLoadedAccounts, failWithStep } from "./t3work-useCreateProjectHelpers";
import { loadPersistedAccountsStep } from "./t3work-useCreateProjectLoadPersisted";

export type CreateProjectStep = "source" | "account" | "project" | "confirm" | "creating";
export type AtlassianBasicCredentials = { siteUrl: string; email: string; apiToken: string };
type CreateProjectOptions = {
  readonly linkedRepositoryUrls?: ReadonlyArray<string>;
  readonly setupProfileId?: string;
  readonly customProfile?: T3WorkProfile | undefined;
};

export function useCreateProject() {
  const backend = useBackend();
  const [step, setStep] = useState<CreateProjectStep>("source");
  const [bootstrapping, setBootstrapping] = useState(true);
  const [accounts, setAccounts] = useState<ReadonlyArray<IntegrationAccount>>([]);
  const [selectedAccount, setSelectedAccount] = useState<IntegrationAccount | null>(null);
  const [projects, setProjects] = useState<ReadonlyArray<ExternalProject>>([]);
  const [selectedProject, setSelectedProject] = useState<ExternalProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);

  const fail = useCallback(
    (value: unknown, fallback: string, nextStep: CreateProjectStep = "source") =>
      failWithStep(setError, setStep, value, fallback, nextStep),
    [],
  );

  const applyAccounts = useCallback(
    (loadedAccounts: ReadonlyArray<IntegrationAccount>) =>
      applyLoadedAccounts({
        loadedAccounts,
        setAccounts,
        setSelectedProject,
        setError,
        setStep,
        setSelectedAccount,
      }),
    [],
  );

  const loadPersistedAccounts = useCallback(async () => {
    await loadPersistedAccountsStep({
      backend,
      setAccounts,
      setSelectedAccount,
      setSelectedProject,
      setProjects,
      setStep,
      setBootstrapping,
      setLoadingAccounts,
      setLoadingProjects,
      setError,
      fail,
    });
  }, [backend, fail]);

  const loadAccountsWithOAuth = useCallback(
    async (sites: ReadonlyArray<AtlassianAccessibleResource>, token: TokenExchangeResult) => {
      setError(null);
      setLoadingAccounts(true);
      try {
        if (!backend) throw new Error("Backend not available");
        const loadedAccounts = await backend.atlassian.connectOAuth({ sites, token });
        writeIntegrationCache("atlassian:listAccounts", loadedAccounts);
        applyAccounts(loadedAccounts);
      } catch (e) {
        fail(e, "Failed to connect Atlassian");
      } finally {
        setLoadingAccounts(false);
      }
    },
    [applyAccounts, backend, fail],
  );

  const loadAccountsWithBasic = useCallback(
    async (credentials: AtlassianBasicCredentials) => {
      setError(null);
      setLoadingAccounts(true);
      try {
        if (!backend) throw new Error("Backend not available");
        const loadedAccounts = await backend.atlassian.connectBasic({
          ...credentials,
          siteUrl: normalizeAtlassianUrl(credentials.siteUrl),
        });
        writeIntegrationCache("atlassian:listAccounts", loadedAccounts);
        applyAccounts(loadedAccounts);
      } catch (e) {
        fail(e, "Failed to connect Atlassian");
      } finally {
        setLoadingAccounts(false);
      }
    },
    [applyAccounts, backend, fail],
  );

  const loadProjects = useCallback(
    async (account: IntegrationAccount) =>
      loadProjectsForAccount({
        backend,
        account,
        setError,
        setLoadingProjects,
        setSelectedAccount,
        setSelectedProject,
        setProjects,
        setStep,
        fail,
      }),
    [backend, fail],
  );

  const createProject = useCallback(
    async (
      externalProject: ExternalProject,
      options?: CreateProjectOptions,
    ): Promise<ProjectShellProject> => {
      setStep("creating");
      setError(null);
      try {
        if (!backend) throw new Error("Backend not available");
        if (!selectedAccount)
          throw new Error("Select an Atlassian site before creating a project.");
        const linkedRepositoryUrls = normalizeRepositoryUrls(options?.linkedRepositoryUrls);
        const setupProfileId = resolveT3WorkProjectSetupProfileId(
          options?.setupProfileId ?? readT3workProjectSetupProfile(),
        );
        const project = await Effect.runPromise(
          t3workCreateProject({
            title: externalProject.title,
            sourceProvider: externalProject.provider,
            accountId: selectedAccount.id,
            externalProjectId: externalProject.id,
            ...(externalProject.key ? { externalProjectKey: externalProject.key } : {}),
            ...(externalProject.url ? { externalProjectUrl: externalProject.url } : {}),
            raw: buildInitialRaw(externalProject.raw, linkedRepositoryUrls, setupProfileId),
          }),
        );
        return await finalizeCreatedProject({
          backend,
          project,
          linkedRepositoryUrls,
          setupProfileId,
          ...(options?.customProfile ? { customProfile: options.customProfile } : {}),
        });
      } catch (e) {
        fail(e, "Failed to create project", "project");
        throw e;
      }
    },
    [backend, fail, selectedAccount],
  );

  return {
    step,
    accounts,
    selectedAccount,
    projects,
    selectedProject,
    error,
    bootstrapping,
    loadingAccounts,
    loadingProjects,
    setStep,
    setSelectedAccount,
    setSelectedProject,
    loadAccountsWithOAuth,
    loadAccountsWithBasic,
    loadPersistedAccounts,
    loadProjects,
    createProject,
    isValidUrl: isValidAtlassianUrl,
  };
}
