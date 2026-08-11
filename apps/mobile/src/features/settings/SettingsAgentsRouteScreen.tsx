import { useAtomCommand } from "../../state/use-atom-command";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AsyncResult } from "effect/unstable/reactivity";
import { AgentProfileId } from "@t3tools/contracts";
import type {
  AgentCatalogDiagnostic,
  AgentProfileSummary,
  AgentRuleSummary,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { useProjects } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  agentEnvironment,
  profileKey,
  sortAgentProfiles,
  useAgentProfileCatalog,
} from "../../state/agents";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsSection } from "./components/SettingsSection";
import { ControlPillMenu } from "../../components/ControlPill";
import { ComposerToolbarTrigger } from "../../components/ComposerToolbarTrigger";
import {
  buildAgentProfileDocument,
  draftFromProfile,
  isProfileDocumentForSummary,
  resolveProfileBaselineForSave,
  type AgentProfileDraft,
} from "./agentProfile.logic";
import {
  agentSettingsContextKey,
  hasMatchingAgentSettingsSummary,
  resolveAgentSettingsEnvironmentId,
  selectAgentSettingsSummary,
} from "./agentSettings.logic";
import {
  buildAgentRuleDocument,
  draftFromRule,
  isRuleDocumentForSummary,
  resolveRuleBaselineForSave,
  sortAgentRules,
  type AgentRuleDraft,
} from "./agentRule.logic";

const diagnosticLabel = (diagnostic: AgentCatalogDiagnostic): string =>
  `${diagnostic.scope} ${diagnostic.kind}${diagnostic.id ? ` '${diagnostic.id}'` : ""}: ${diagnostic.message}`;

export function SettingsAgentsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environments = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedRuleKey, setSelectedRuleKey] = useState<string | null>(null);
  const [optimisticProfileSummary, setOptimisticProfileSummary] =
    useState<AgentProfileSummary | null>(null);
  const [optimisticRuleSummary, setOptimisticRuleSummary] = useState<AgentRuleSummary | null>(null);
  const [contextGeneration, setContextGeneration] = useState(0);
  const [draft, setDraft] = useState<AgentProfileDraft>(() => draftFromProfile());
  const [isNew, setIsNew] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<AgentRuleDraft>(() => draftFromRule());
  const [isNewRule, setIsNewRule] = useState(false);
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [profileCommandPending, setProfileCommandPending] = useState(false);
  const [ruleCommandPending, setRuleCommandPending] = useState(false);
  const profileCommandInFlight = useRef(false);
  const ruleCommandInFlight = useRef(false);
  const resolvedEnvironmentId = environmentId;
  const projectOptions = projects.filter(
    (project) => project.environmentId === resolvedEnvironmentId,
  );
  const selectedProject = projectOptions.find((project) => project.id === projectId) ?? null;
  const catalog = useAgentProfileCatalog(resolvedEnvironmentId, projectId, {
    includeArchived: true,
  });
  const catalogProfileSummary =
    catalog.data?.profiles.find((profile) => profileKey(profile) === selectedKey) ?? null;
  const catalogRuleSummary =
    catalog.data?.rules.find((rule) => profileKey(rule) === selectedRuleKey) ?? null;
  const selectedSummary = selectAgentSettingsSummary(
    selectedKey,
    catalogProfileSummary,
    optimisticProfileSummary,
  );
  const selectedRuleSummary = selectAgentSettingsSummary(
    selectedRuleKey,
    catalogRuleSummary,
    optimisticRuleSummary,
  );
  const profileContextKey = agentSettingsContextKey({
    environmentId: resolvedEnvironmentId,
    projectId: selectedProject?.id?.toString() ?? null,
    selectionKey: selectedKey,
    generation: contextGeneration,
  });
  const ruleContextKey = agentSettingsContextKey({
    environmentId: resolvedEnvironmentId,
    projectId: selectedProject?.id?.toString() ?? null,
    selectionKey: selectedRuleKey,
    generation: contextGeneration,
  });
  const profileContextKeyRef = useRef(profileContextKey);
  const ruleContextKeyRef = useRef(ruleContextKey);
  profileContextKeyRef.current = profileContextKey;
  ruleContextKeyRef.current = ruleContextKey;
  const profileQuery = useEnvironmentQuery(
    resolvedEnvironmentId === null || selectedSummary === null
      ? null
      : agentEnvironment.profile({
          environmentId: resolvedEnvironmentId,
          input: {
            id: selectedSummary.id,
            scope: selectedSummary.scope,
            revision: selectedSummary.revision,
            ...(selectedProject ? { projectId: selectedProject.id } : {}),
          },
        }),
  );
  const saveProfile = useAtomCommand(agentEnvironment.saveProfile, { reportFailure: false });
  const archiveProfile = useAtomCommand(agentEnvironment.archiveProfile, { reportFailure: false });
  const restoreProfile = useAtomCommand(agentEnvironment.restoreProfile, { reportFailure: false });
  const saveRule = useAtomCommand(agentEnvironment.saveRule, { reportFailure: false });
  const archiveRule = useAtomCommand(agentEnvironment.archiveRule, { reportFailure: false });
  const restoreRule = useAtomCommand(agentEnvironment.restoreRule, { reportFailure: false });

  useEffect(() => {
    const nextEnvironmentId = resolveAgentSettingsEnvironmentId(
      environmentId,
      environments.map((environment) => environment.environmentId),
    );
    if (nextEnvironmentId === environmentId) return;

    if (environmentId !== null) {
      setContextGeneration((generation) => generation + 1);
      setProjectId(null);
      setSelectedKey(null);
      setSelectedRuleKey(null);
      setOptimisticProfileSummary(null);
      setOptimisticRuleSummary(null);
      setIsNew(false);
      setIsNewRule(false);
      setDraft(draftFromProfile());
      setRuleDraft(draftFromRule());
      setNotice(null);
      setError(null);
      setRuleNotice(null);
      setRuleError(null);
    }
    setEnvironmentId(nextEnvironmentId);
  }, [environmentId, environments]);

  useEffect(() => {
    if (!environments.some((environment) => environment.environmentId === resolvedEnvironmentId)) {
      return;
    }
    if (isProfileDocumentForSummary(profileQuery.data?.profile, selectedSummary)) {
      setDraft(draftFromProfile(profileQuery.data.profile));
      setIsNew(false);
    }
  }, [
    environments,
    profileQuery.data,
    resolvedEnvironmentId,
    selectedProject?.id,
    selectedSummary,
  ]);
  useEffect(() => {
    if (hasMatchingAgentSettingsSummary(optimisticProfileSummary, catalogProfileSummary)) {
      setOptimisticProfileSummary(null);
    }
  }, [catalogProfileSummary, optimisticProfileSummary]);
  const ruleQuery = useEnvironmentQuery(
    resolvedEnvironmentId === null || selectedRuleSummary === null
      ? null
      : agentEnvironment.rule({
          environmentId: resolvedEnvironmentId,
          input: {
            id: AgentProfileId.make(selectedRuleSummary.id),
            scope: selectedRuleSummary.scope,
            revision: selectedRuleSummary.revision,
            ...(selectedProject ? { projectId: selectedProject.id } : {}),
          },
        }),
  );
  useEffect(() => {
    if (!environments.some((environment) => environment.environmentId === resolvedEnvironmentId)) {
      return;
    }
    if (isRuleDocumentForSummary(ruleQuery.data?.rule, selectedRuleSummary)) {
      setRuleDraft(draftFromRule(ruleQuery.data.rule));
      setIsNewRule(false);
    }
  }, [
    environments,
    resolvedEnvironmentId,
    ruleQuery.data,
    selectedProject?.id,
    selectedRuleSummary,
  ]);
  useEffect(() => {
    if (hasMatchingAgentSettingsSummary(optimisticRuleSummary, catalogRuleSummary)) {
      setOptimisticRuleSummary(null);
    }
  }, [catalogRuleSummary, optimisticRuleSummary]);
  useEffect(() => {
    if (projectId !== null && selectedProject === null) {
      setContextGeneration((generation) => generation + 1);
      setProjectId(null);
      setSelectedKey(null);
      setSelectedRuleKey(null);
      setOptimisticProfileSummary(null);
      setOptimisticRuleSummary(null);
      setIsNew(false);
      setIsNewRule(false);
      setDraft(draftFromProfile());
      setRuleDraft(draftFromRule());
    }
  }, [projectId, selectedProject]);

  const profiles = useMemo(
    () => sortAgentProfiles(catalog.data?.profiles ?? []),
    [catalog.data?.profiles],
  );
  const rules = useMemo(() => sortAgentRules(catalog.data?.rules ?? []), [catalog.data?.rules]);
  const environmentMenuActions = environments.map((environment) => ({
    id: `environment:${environment.environmentId}`,
    title: environment.environmentLabel,
    state: environment.environmentId === resolvedEnvironmentId ? ("on" as const) : undefined,
  }));
  const projectMenuActions = [
    {
      id: "project:none",
      title: "Environment profiles",
      state: projectId === null ? ("on" as const) : undefined,
    },
    ...projectOptions.map((project) => ({
      id: `project:${project.id}`,
      title: project.title,
      state: project.id === projectId ? ("on" as const) : undefined,
    })),
  ];
  const handleContextMenu = useCallback((event: string) => {
    if (event.startsWith("environment:")) {
      setContextGeneration((generation) => generation + 1);
      setEnvironmentId(event.slice("environment:".length) as EnvironmentId);
      setProjectId(null);
      setSelectedKey(null);
      setSelectedRuleKey(null);
      setOptimisticProfileSummary(null);
      setOptimisticRuleSummary(null);
      setIsNew(false);
      setIsNewRule(false);
    } else if (event === "project:none") {
      setContextGeneration((generation) => generation + 1);
      setProjectId(null);
      setSelectedKey(null);
      setSelectedRuleKey(null);
      setOptimisticProfileSummary(null);
      setOptimisticRuleSummary(null);
      setIsNew(false);
      setIsNewRule(false);
    } else if (event.startsWith("project:")) {
      setContextGeneration((generation) => generation + 1);
      setProjectId(event.slice("project:".length) as ProjectId);
      setSelectedKey(null);
      setSelectedRuleKey(null);
      setOptimisticProfileSummary(null);
      setOptimisticRuleSummary(null);
      setIsNew(false);
      setIsNewRule(false);
    }
  }, []);
  const updateDraft = useCallback(
    <K extends keyof AgentProfileDraft>(key: K, value: AgentProfileDraft[K]) => {
      setDraft((current) => ({ ...current, [key]: value }));
      setNotice(null);
      setError(null);
    },
    [],
  );
  const startNew = useCallback(() => {
    setContextGeneration((generation) => generation + 1);
    setSelectedKey(null);
    setOptimisticProfileSummary(null);
    setIsNew(true);
    setDraft(draftFromProfile(null, projectId === null ? "environment" : "project"));
    setError(null);
    setNotice(null);
  }, [projectId]);
  const startNewRule = useCallback(() => {
    setContextGeneration((generation) => generation + 1);
    setSelectedRuleKey(null);
    setOptimisticRuleSummary(null);
    setIsNewRule(true);
    setRuleDraft(draftFromRule(null, projectId === null ? "environment" : "project"));
    setRuleError(null);
    setRuleNotice(null);
  }, [projectId]);
  const updateRuleDraft = useCallback(
    <K extends keyof AgentRuleDraft>(key: K, value: AgentRuleDraft[K]) => {
      setRuleDraft((current) => ({ ...current, [key]: value }));
      setRuleNotice(null);
      setRuleError(null);
    },
    [],
  );
  const saveRuleDocument = useCallback(async () => {
    if (resolvedEnvironmentId === null) {
      setRuleError("Connect an environment before saving a rule.");
      return;
    }
    if (ruleCommandInFlight.current) return;
    if (!ruleDraft.id.trim() || !ruleDraft.name.trim()) {
      setRuleError("Rule id and name are required.");
      return;
    }
    if (ruleDraft.scope === "project" && selectedProject === null) {
      setRuleError("Choose a project for a project-scoped rule.");
      return;
    }
    const saveContextKey = ruleContextKey;
    ruleCommandInFlight.current = true;
    setRuleCommandPending(true);
    try {
      const baseline = resolveRuleBaselineForSave(
        isNewRule,
        selectedRuleSummary,
        ruleQuery.data?.rule,
      );
      const document = buildAgentRuleDocument(ruleDraft, baseline);
      const result = await saveRule({
        environmentId: resolvedEnvironmentId,
        input: {
          rule: document,
          ...(baseline === null ? {} : { expectedRevision: baseline.revision }),
          ...(document.scope === "project" && selectedProject
            ? { projectId: selectedProject.id }
            : {}),
        },
      });
      if (AsyncResult.isFailure(result))
        throw new Error("The rule could not be saved (it may have changed remotely).");
      if (ruleContextKeyRef.current !== saveContextKey) return;
      setSelectedRuleKey(profileKey(result.value.rule));
      setOptimisticRuleSummary(result.value.rule);
      setIsNewRule(false);
      setRuleNotice("Rule saved.");
      catalog.refresh();
    } catch (caught) {
      if (ruleContextKeyRef.current !== saveContextKey) return;
      setRuleError(caught instanceof Error ? caught.message : "The rule could not be saved.");
    } finally {
      ruleCommandInFlight.current = false;
      setRuleCommandPending(false);
    }
  }, [
    catalog,
    isNewRule,
    resolvedEnvironmentId,
    ruleDraft,
    ruleQuery.data?.rule,
    saveRule,
    selectedProject,
    selectedRuleSummary,
    ruleContextKey,
  ]);
  const archiveRestoreRule = useCallback(async () => {
    if (resolvedEnvironmentId === null) {
      setRuleError("Connect an environment before updating a rule.");
      return;
    }
    if (selectedRuleSummary === null || ruleCommandInFlight.current) return;
    const actionContextKey = ruleContextKey;
    ruleCommandInFlight.current = true;
    setRuleCommandPending(true);
    try {
      const command = selectedRuleSummary.archivedAt ? restoreRule : archiveRule;
      const result = await command({
        environmentId: resolvedEnvironmentId,
        input: {
          id: AgentProfileId.make(selectedRuleSummary.id),
          scope: selectedRuleSummary.scope,
          expectedRevision: selectedRuleSummary.revision,
          ...(selectedRuleSummary.scope === "project" && selectedProject
            ? { projectId: selectedProject.id }
            : {}),
        },
      });
      if (AsyncResult.isFailure(result)) {
        if (ruleContextKeyRef.current !== actionContextKey) return;
        setRuleError("The rule could not be updated (it may have changed remotely).");
        return;
      }
      if (ruleContextKeyRef.current !== actionContextKey) return;
      setRuleNotice(selectedRuleSummary.archivedAt ? "Rule restored." : "Rule archived.");
      catalog.refresh();
    } catch (caught) {
      if (ruleContextKeyRef.current !== actionContextKey) return;
      setRuleError(caught instanceof Error ? caught.message : "The rule could not be updated.");
    } finally {
      ruleCommandInFlight.current = false;
      setRuleCommandPending(false);
    }
  }, [
    archiveRule,
    catalog,
    resolvedEnvironmentId,
    restoreRule,
    selectedProject,
    selectedRuleSummary,
    ruleContextKey,
  ]);
  const save = useCallback(async () => {
    if (resolvedEnvironmentId === null) {
      setError("Connect an environment before saving a profile.");
      return;
    }
    if (profileCommandInFlight.current) return;
    if (!draft.id.trim() || !draft.name.trim()) {
      setError("Profile id and name are required.");
      return;
    }
    if (draft.scope === "project" && selectedProject === null) {
      setError("Choose a project for a project-scoped profile.");
      return;
    }
    const saveContextKey = profileContextKey;
    profileCommandInFlight.current = true;
    setProfileCommandPending(true);
    try {
      const baseline = resolveProfileBaselineForSave(
        isNew,
        selectedSummary,
        profileQuery.data?.profile,
      );
      const document = buildAgentProfileDocument(draft, baseline);
      const result = await saveProfile({
        environmentId: resolvedEnvironmentId,
        input: {
          profile: document,
          ...(baseline === null ? {} : { expectedRevision: baseline.revision }),
          ...(document.scope === "project" && selectedProject
            ? { projectId: selectedProject.id }
            : {}),
        },
      });
      if (AsyncResult.isFailure(result)) throw new Error("The profile could not be saved.");
      if (profileContextKeyRef.current !== saveContextKey) return;
      setSelectedKey(profileKey(result.value.profile));
      setOptimisticProfileSummary(result.value.profile);
      setIsNew(false);
      setNotice("Profile saved.");
      catalog.refresh();
    } catch (caught) {
      if (profileContextKeyRef.current !== saveContextKey) return;
      setError(caught instanceof Error ? caught.message : "The profile could not be saved.");
    } finally {
      profileCommandInFlight.current = false;
      setProfileCommandPending(false);
    }
  }, [
    catalog,
    draft,
    isNew,
    profileQuery.data?.profile,
    resolvedEnvironmentId,
    saveProfile,
    selectedProject,
    selectedSummary,
    profileContextKey,
  ]);
  const archiveRestore = useCallback(async () => {
    if (resolvedEnvironmentId === null) {
      setError("Connect an environment before updating a profile.");
      return;
    }
    if (selectedSummary === null || profileCommandInFlight.current) return;
    const actionContextKey = profileContextKey;
    profileCommandInFlight.current = true;
    setProfileCommandPending(true);
    try {
      const command = selectedSummary.archivedAt ? restoreProfile : archiveProfile;
      const result = await command({
        environmentId: resolvedEnvironmentId,
        input: {
          id: selectedSummary.id,
          scope: selectedSummary.scope,
          expectedRevision: selectedSummary.revision,
          ...(selectedSummary.scope === "project" && selectedProject
            ? { projectId: selectedProject.id }
            : {}),
        },
      });
      if (AsyncResult.isFailure(result)) {
        if (profileContextKeyRef.current !== actionContextKey) return;
        setError("The profile could not be updated.");
        return;
      }
      if (profileContextKeyRef.current !== actionContextKey) return;
      setNotice(selectedSummary.archivedAt ? "Profile restored." : "Profile archived.");
      catalog.refresh();
    } catch (caught) {
      if (profileContextKeyRef.current !== actionContextKey) return;
      setError(caught instanceof Error ? caught.message : "The profile could not be updated.");
    } finally {
      profileCommandInFlight.current = false;
      setProfileCommandPending(false);
    }
  }, [
    archiveProfile,
    catalog,
    resolvedEnvironmentId,
    restoreProfile,
    selectedProject,
    selectedSummary,
    profileContextKey,
  ]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Agents" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Agents">
          <View className="flex-row items-center justify-between gap-3 p-4">
            <Text className="text-lg text-foreground">Environment</Text>
            <ControlPillMenu
              actions={environmentMenuActions}
              onPressAction={({ nativeEvent }) => handleContextMenu(nativeEvent.event)}
            >
              <ComposerToolbarTrigger
                accessibilityLabel="Agent environment"
                icon="desktopcomputer"
                label={
                  environments.find(
                    (environment) => environment.environmentId === resolvedEnvironmentId,
                  )?.environmentLabel ?? "Choose"
                }
              />
            </ControlPillMenu>
          </View>
          <View className="flex-row items-center justify-between gap-3 p-4">
            <Text className="text-lg text-foreground">Project</Text>
            <ControlPillMenu
              actions={projectMenuActions}
              onPressAction={({ nativeEvent }) => handleContextMenu(nativeEvent.event)}
            >
              <ComposerToolbarTrigger
                accessibilityLabel="Agent project"
                icon="folder"
                label={selectedProject?.title ?? "Environment profiles"}
              />
            </ControlPillMenu>
          </View>
        </SettingsSection>
        <View className="gap-3">
          <View className="flex-row items-center justify-between px-2">
            <Text className="text-sm font-t3-bold text-foreground-muted">Profile catalog</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New agent profile"
              accessibilityState={{ disabled: resolvedEnvironmentId === null }}
              disabled={resolvedEnvironmentId === null}
              onPress={startNew}
              className="rounded-full bg-primary px-3 py-2 disabled:opacity-40 active:opacity-70"
            >
              <Text className="text-sm font-t3-bold text-primary-foreground">New profile</Text>
            </Pressable>
          </View>
          <View className="overflow-hidden rounded-2xl bg-subtle">
            {(catalog.data?.diagnostics.length ?? 0) > 0 ? (
              <View className="gap-1 border-b border-warning/30 bg-warning/10 p-4">
                <Text accessibilityRole="alert" className="text-sm font-t3-bold text-warning">
                  Some Agent files could not be loaded.
                </Text>
                {catalog.data?.diagnostics.slice(0, 3).map((diagnostic, index) => (
                  <Text
                    key={`${diagnostic.code}:${diagnostic.sourcePath ?? diagnostic.id ?? index}`}
                    className="text-xs text-warning"
                  >
                    {diagnosticLabel(diagnostic)}
                  </Text>
                ))}
              </View>
            ) : null}
            {catalog.isPending && catalog.data === null ? (
              <Text className="p-4 text-sm text-foreground-muted">Loading profiles…</Text>
            ) : null}
            {catalog.error ? (
              <Text accessibilityRole="alert" className="p-4 text-sm text-danger">
                {catalog.error}
              </Text>
            ) : null}
            {!catalog.isPending && !catalog.error && profiles.length === 0 ? (
              <Text className="p-4 text-sm text-foreground-muted">
                No profiles yet. Create one to reuse provider-neutral instructions.
              </Text>
            ) : null}
            {profiles.map((profile) => (
              <ProfileRow
                key={profileKey(profile)}
                profile={profile}
                selected={profileKey(profile) === selectedKey}
                onPress={() => {
                  setContextGeneration((generation) => generation + 1);
                  setSelectedKey(profileKey(profile));
                  setOptimisticProfileSummary(null);
                  setIsNew(false);
                  setError(null);
                  setNotice(null);
                }}
              />
            ))}
          </View>
        </View>
        {isNew || selectedSummary ? (
          <ProfileEditor
            draft={draft}
            selectedSummary={selectedSummary}
            loading={profileQuery.isPending}
            commandPending={profileCommandPending}
            notice={notice}
            error={error}
            onChange={updateDraft}
            onSave={() => void save()}
            onArchiveRestore={() => void archiveRestore()}
          />
        ) : (
          <Text className="px-2 py-6 text-center text-sm text-foreground-muted">
            Select a profile to edit its instructions and policy.
          </Text>
        )}
        <View className="gap-3">
          <View className="flex-row items-center justify-between px-2">
            <Text className="text-sm font-t3-bold text-foreground-muted">Rules catalog</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New agent rule"
              accessibilityState={{ disabled: resolvedEnvironmentId === null }}
              disabled={resolvedEnvironmentId === null}
              onPress={startNewRule}
              className="rounded-full bg-primary px-3 py-2 disabled:opacity-40 active:opacity-70"
            >
              <Text className="text-sm font-t3-bold text-primary-foreground">New rule</Text>
            </Pressable>
          </View>
          <View className="overflow-hidden rounded-2xl bg-subtle">
            {catalog.isPending && catalog.data === null ? (
              <Text className="p-4 text-sm text-foreground-muted">Loading rules…</Text>
            ) : null}
            {catalog.error ? (
              <Text accessibilityRole="alert" className="p-4 text-sm text-danger">
                {catalog.error}
              </Text>
            ) : null}
            {!catalog.isPending && !catalog.error && rules.length === 0 ? (
              <Text className="p-4 text-sm text-foreground-muted">
                No rules yet. Create one to apply reusable instructions by path.
              </Text>
            ) : null}
            {rules.map((rule) => (
              <RuleRow
                key={profileKey(rule)}
                rule={rule}
                selected={profileKey(rule) === selectedRuleKey}
                onPress={() => {
                  setContextGeneration((generation) => generation + 1);
                  setSelectedRuleKey(profileKey(rule));
                  setOptimisticRuleSummary(null);
                  setIsNewRule(false);
                  setRuleError(null);
                  setRuleNotice(null);
                }}
              />
            ))}
          </View>
        </View>
        {isNewRule || selectedRuleSummary ? (
          <RuleEditor
            draft={ruleDraft}
            selectedSummary={selectedRuleSummary}
            loading={ruleQuery.isPending}
            commandPending={ruleCommandPending}
            notice={ruleNotice}
            error={ruleError}
            onChange={updateRuleDraft}
            onSave={() => void saveRuleDocument()}
            onArchiveRestore={() => void archiveRestoreRule()}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function ProfileRow(props: {
  profile: AgentProfileSummary;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={`flex-row items-center gap-3 p-4 ${props.selected ? "bg-subtle-strong" : ""} active:opacity-70`}
    >
      <View className="size-9 items-center justify-center rounded-xl bg-primary/12">
        <Text className="text-base font-t3-bold text-primary">✦</Text>
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
          {props.profile.name}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.profile.description ?? props.profile.id}
        </Text>
      </View>
      <View className="items-end gap-1">
        <Text className="text-xs uppercase text-foreground-muted">{props.profile.scope}</Text>
        <Text className="text-[10px] uppercase text-foreground-muted">
          {props.profile.chatSelectable ? "chat" : "delegation only"}
        </Text>
      </View>
    </Pressable>
  );
}

function ProfileEditor(props: {
  draft: AgentProfileDraft;
  selectedSummary: AgentProfileSummary | null;
  loading: boolean;
  commandPending: boolean;
  notice: string | null;
  error: string | null;
  onChange: <K extends keyof AgentProfileDraft>(key: K, value: AgentProfileDraft[K]) => void;
  onSave: () => void;
  onArchiveRestore: () => void;
}) {
  const field = (key: keyof AgentProfileDraft, label: string, multiline = false) => (
    <View className="gap-1.5">
      <Text className="px-1 text-sm font-t3-bold text-foreground">{label}</Text>
      <AppTextInput
        accessibilityLabel={label}
        multiline={multiline}
        value={String(props.draft[key])}
        editable={!props.loading && (key !== "id" || props.selectedSummary === null)}
        onChangeText={(value) => props.onChange(key, value as never)}
        className={multiline ? "min-h-32" : undefined}
      />
    </View>
  );
  return (
    <View className="gap-4 rounded-2xl bg-subtle p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-lg font-t3-bold text-foreground">
            {props.selectedSummary ? props.draft.name || "Agent profile" : "New agent profile"}
          </Text>
          <Text className="mt-1 text-sm text-foreground-muted">
            Provider-neutral policy pinned by revision.
          </Text>
        </View>
        {props.selectedSummary ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: props.loading || props.commandPending }}
            disabled={props.loading || props.commandPending}
            onPress={props.onArchiveRestore}
            className="rounded-full px-2 py-1 disabled:opacity-40 active:opacity-70"
          >
            <Text className="text-sm text-primary">
              {props.selectedSummary.archivedAt ? "Restore" : "Archive"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {props.error ? (
        <Text accessibilityRole="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {props.error}
        </Text>
      ) : null}
      {props.notice ? (
        <Text
          accessibilityRole="text"
          className="rounded-xl bg-success/10 p-3 text-sm text-success"
        >
          {props.notice}
        </Text>
      ) : null}
      {field("id", "Profile id")}
      {field("name", "Name")}
      {field("description", "Description")}
      <View className="flex-row items-center justify-between gap-4 rounded-xl bg-input px-3.5 py-3">
        <View className="min-w-0 flex-1">
          <Text className="text-base text-foreground">Show in chat Agent picker</Text>
          <Text className="mt-0.5 text-xs text-foreground-muted">
            Turn off for profiles that should only be started by orchestration.
          </Text>
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Show in chat Agent picker"
          accessibilityState={{ checked: props.draft.chatSelectable }}
          disabled={props.loading || props.commandPending}
          onPress={() => props.onChange("chatSelectable", !props.draft.chatSelectable)}
          className={`rounded-full px-3 py-1 disabled:opacity-40 ${props.draft.chatSelectable ? "bg-primary" : "bg-subtle-strong"}`}
        >
          <Text
            className={`text-sm font-t3-bold ${props.draft.chatSelectable ? "text-primary-foreground" : "text-foreground-muted"}`}
          >
            {props.draft.chatSelectable ? "On" : "Off"}
          </Text>
        </Pressable>
      </View>
      {field("instructions", "Instructions", true)}
      <Text className="text-xs text-foreground-muted">
        Runtime: {props.draft.runtimeMode} · Interaction: {props.draft.interactionMode} · Workspace:{" "}
        {props.draft.workspaceMode}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save agent profile"
        accessibilityState={{ disabled: props.loading || props.commandPending }}
        disabled={props.loading || props.commandPending}
        onPress={props.onSave}
        className="items-center rounded-xl bg-primary px-4 py-3 disabled:opacity-40 active:opacity-70"
      >
        <Text className="font-t3-bold text-primary-foreground">
          {props.commandPending ? "Saving…" : "Save profile"}
        </Text>
      </Pressable>
    </View>
  );
}

function RuleRow(props: { rule: AgentRuleSummary; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={`flex-row items-center gap-3 p-4 ${props.selected ? "bg-subtle-strong" : ""} active:opacity-70`}
    >
      <View className="size-9 items-center justify-center rounded-xl bg-primary/12">
        <Text className="text-base font-t3-bold text-primary">⌁</Text>
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
          {props.rule.name}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.rule.globs.join(", ") || (props.rule.alwaysApply ? "Always apply" : props.rule.id)}
        </Text>
      </View>
      <Text className="text-xs uppercase text-foreground-muted">{props.rule.scope}</Text>
    </Pressable>
  );
}

function RuleEditor(props: {
  draft: AgentRuleDraft;
  selectedSummary: AgentRuleSummary | null;
  loading: boolean;
  commandPending: boolean;
  notice: string | null;
  error: string | null;
  onChange: <K extends keyof AgentRuleDraft>(key: K, value: AgentRuleDraft[K]) => void;
  onSave: () => void;
  onArchiveRestore: () => void;
}) {
  const field = (key: keyof AgentRuleDraft, label: string, multiline = false) => (
    <View className="gap-1.5">
      <Text className="px-1 text-sm font-t3-bold text-foreground">{label}</Text>
      <AppTextInput
        accessibilityLabel={label}
        multiline={multiline}
        value={String(props.draft[key])}
        editable={!props.loading && (key !== "id" || props.selectedSummary === null)}
        onChangeText={(value) => props.onChange(key, value as never)}
        className={multiline ? "min-h-32" : undefined}
      />
    </View>
  );
  return (
    <View className="gap-4 rounded-2xl bg-subtle p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-lg font-t3-bold text-foreground">
            {props.selectedSummary ? props.draft.name || "Agent rule" : "New agent rule"}
          </Text>
          <Text className="mt-1 text-sm text-foreground-muted">
            Apply instruction text by glob or to every turn.
          </Text>
        </View>
        {props.selectedSummary ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: props.loading || props.commandPending }}
            disabled={props.loading || props.commandPending}
            onPress={props.onArchiveRestore}
            className="rounded-full px-2 py-1 disabled:opacity-40 active:opacity-70"
          >
            <Text className="text-sm text-primary">
              {props.selectedSummary.archivedAt ? "Restore" : "Archive"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {props.error ? (
        <Text accessibilityRole="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {props.error}
        </Text>
      ) : null}
      {props.notice ? (
        <Text
          accessibilityRole="text"
          className="rounded-xl bg-success/10 p-3 text-sm text-success"
        >
          {props.notice}
        </Text>
      ) : null}
      {field("id", "Rule id")}
      {field("name", "Name")}
      {field("description", "Description")}
      {field("globs", "Globs (one per line)", true)}
      <View className="flex-row items-center justify-between rounded-xl bg-input px-3.5 py-3">
        <Text className="text-base text-foreground">Always apply</Text>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Always apply"
          accessibilityState={{ checked: props.draft.alwaysApply }}
          disabled={props.loading || props.commandPending}
          onPress={() => props.onChange("alwaysApply", !props.draft.alwaysApply)}
          className={`rounded-full px-3 py-1 disabled:opacity-40 ${props.draft.alwaysApply ? "bg-primary" : "bg-subtle-strong"}`}
        >
          <Text
            className={`text-sm font-t3-bold ${props.draft.alwaysApply ? "text-primary-foreground" : "text-foreground-muted"}`}
          >
            {props.draft.alwaysApply ? "On" : "Off"}
          </Text>
        </Pressable>
      </View>
      {field("priority", "Priority (-100 to 100)")}
      {field("profiles", "Target profiles (id or scope:id)")}
      {field("body", "Rule instructions", true)}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save agent rule"
        accessibilityState={{ disabled: props.loading || props.commandPending }}
        disabled={props.loading || props.commandPending}
        onPress={props.onSave}
        className="items-center rounded-xl bg-primary px-4 py-3 disabled:opacity-40 active:opacity-70"
      >
        <Text className="font-t3-bold text-primary-foreground">
          {props.commandPending ? "Saving…" : "Save rule"}
        </Text>
      </Pressable>
    </View>
  );
}
