import { useEffect, useMemo, useState } from "react";
import type { ProjectShellProject } from "@t3tools/project-context";
import type { T3WorkProfile } from "@t3tools/t3work-skill-packs";
import { splitRepositoryInput } from "~/t3work/components/t3work-linkedRepositories";
import { useAtlassianOAuth } from "~/t3work/hooks/t3work-useAtlassianOAuth";
import { useCreateProject } from "~/t3work/hooks/t3work-useCreateProject";
import {
  CreateProjectWizardFrame,
  CreateProjectWizardStepTransition,
  type CreateProjectWizardVariant,
} from "~/t3work/t3work-CreateProjectWizardFrame";
import {
  useT3workProjectSetupProfile,
  writeT3workProjectSetupProfile,
} from "~/t3work/t3work-projectSetupProfile";
import { AccountStep, ProjectStep, SourceStep } from "~/t3work/t3work-CreateProjectDialogSteps";
import { ConfirmStep, CreatingStep } from "~/t3work/t3work-CreateProjectDialogConfirmStep";
import { CreateProjectDialogFooter } from "~/t3work/t3work-CreateProjectDialogFooter";

export function CreateProjectDialog({
  onClose,
  onCreated,
  variant = "dialog",
}: {
  onClose: () => void;
  onCreated: (project: ProjectShellProject) => void;
  variant?: CreateProjectWizardVariant;
}) {
  const setup = useCreateProject();
  const oauth = useAtlassianOAuth();
  const {
    loadPersistedAccounts,
    loadAccountsWithOAuth,
    projects,
    selectedAccount,
    selectedProject,
    bootstrapping,
    loadingAccounts,
    loadingProjects,
  } = setup;
  const setupProfileId = useT3workProjectSetupProfile();
  const [siteUrl, setSiteUrl] = useState("https://");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [linkedRepositoryUrls, setLinkedRepositoryUrls] = useState<ReadonlyArray<string>>([]);
  const [discoveredRepositoryUrls, setDiscoveredRepositoryUrls] = useState<ReadonlyArray<string>>(
    [],
  );
  const [newRepositoryUrl, setNewRepositoryUrl] = useState("");
  const [customProfile, setCustomProfile] = useState<T3WorkProfile | undefined>(undefined);

  useEffect(() => {
    void loadPersistedAccounts();
  }, [loadPersistedAccounts]);
  useEffect(() => {
    if (oauth.state.kind !== "done") return;
    void loadAccountsWithOAuth(oauth.state.sites, oauth.state.token);
  }, [oauth.state, loadAccountsWithOAuth]);

  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) =>
      `${project.title} ${project.key ?? ""}`.toLowerCase().includes(query),
    );
  }, [projectQuery, projects]);

  const createSelectedProject = async () => {
    if (!selectedProject) return;
    const project = await setup.createProject(selectedProject, {
      linkedRepositoryUrls,
      setupProfileId,
      ...(customProfile ? { customProfile } : {}),
    });
    onCreated(project);
  };

  const addRepository = () => {
    const normalized = splitRepositoryInput(newRepositoryUrl);
    if (normalized.length === 0) return;
    setLinkedRepositoryUrls((current) => [...new Set([...current, ...normalized])]);
    setNewRepositoryUrl("");
  };

  const removeRepository = (url: string) => {
    setLinkedRepositoryUrls((current) => current.filter((entry) => entry !== url));
  };

  const handleDiscoveredRepositoryUrlsChange = (urls: ReadonlyArray<string>) => {
    setDiscoveredRepositoryUrls(urls);
    if (urls.length === 0) return;
    setLinkedRepositoryUrls((current) => [...new Set([...current, ...urls])]);
  };

  return (
    <CreateProjectWizardFrame
      variant={variant}
      onClose={onClose}
      footer={
        <CreateProjectDialogFooter
          setup={setup}
          oauth={oauth}
          siteUrl={siteUrl}
          email={email}
          apiToken={apiToken}
          selectedAccount={selectedAccount}
          selectedProject={selectedProject}
          bootstrapping={bootstrapping}
          loadingProjects={loadingProjects}
          onCreateProject={createSelectedProject}
        />
      }
    >
      <div className="relative space-y-5 px-5 pb-5 pt-2 sm:px-6 sm:pb-6">
        {setup.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {setup.error}
          </div>
        ) : null}
        <CreateProjectWizardStepTransition step={setup.step}>
          {setup.step === "source" ? (
            <SourceStep
              loading={bootstrapping}
              siteUrl={siteUrl}
              email={email}
              apiToken={apiToken}
              setSiteUrl={setSiteUrl}
              setEmail={setEmail}
              setApiToken={setApiToken}
            />
          ) : null}
          {setup.step === "account" ? (
            <AccountStep
              accounts={setup.accounts}
              selectedAccount={setup.selectedAccount}
              onSelectAccount={setup.setSelectedAccount}
              loading={loadingAccounts}
            />
          ) : null}
          {setup.step === "project" ? (
            <ProjectStep
              filteredProjects={filteredProjects}
              selectedProject={setup.selectedProject}
              projectQuery={projectQuery}
              setProjectQuery={setProjectQuery}
              onSelectProject={setup.setSelectedProject}
              loading={loadingProjects}
            />
          ) : null}
          {setup.step === "confirm" ? (
            <ConfirmStep
              selectedProject={selectedProject}
              setupProfileId={setupProfileId}
              linkedRepositoryUrls={linkedRepositoryUrls}
              discoveredRepositoryUrls={discoveredRepositoryUrls}
              newRepositoryUrl={newRepositoryUrl}
              setNewRepositoryUrl={setNewRepositoryUrl}
              onSetupProfileChange={writeT3workProjectSetupProfile}
              onAddRepository={addRepository}
              onRemoveRepository={removeRepository}
              onAddRepositories={(urls: ReadonlyArray<string>) =>
                setLinkedRepositoryUrls((current) => [...new Set([...current, ...urls])])
              }
              onDiscoveredRepositoryUrlsChange={handleDiscoveredRepositoryUrlsChange}
              customProfile={customProfile}
              onCustomProfileChange={setCustomProfile}
            />
          ) : null}
          {setup.step === "creating" ? (
            <CreatingStep
              projectTitle={selectedProject?.title}
              repositoryCount={linkedRepositoryUrls.length}
              setupProfileId={setupProfileId}
            />
          ) : null}
        </CreateProjectWizardStepTransition>
      </div>
    </CreateProjectWizardFrame>
  );
}
