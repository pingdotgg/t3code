import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ThreadImportCandidate,
  type ThreadImportCommitResult,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useProjects } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

function projectKey(project: { readonly environmentId: string; readonly id: string }): string {
  return `${project.environmentId}:${project.id}`;
}

function providerLabel(provider: ThreadImportCandidate["provider"]): string {
  return provider === "claudeAgent"
    ? "Claude Code"
    : provider === "codex"
      ? "Codex"
      : provider === "cursor"
        ? "Cursor"
        : "Grok";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The import could not be completed.";
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "Unknown time" : new Date(timestamp).toLocaleString();
}

export function ThreadImportRouteScreen() {
  const navigation = useNavigation();
  const projects = useProjects();
  const commitImports = useAtomCommand(orchestrationEnvironment.threadImportCommit, {
    reportFailure: false,
  });
  const sortedProjects = useMemo(
    () => projects.toSorted((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [commitError, setCommitError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    if (sortedProjects.some((project) => projectKey(project) === selectedProjectKey)) return;
    setSelectedProjectKey(sortedProjects[0] ? projectKey(sortedProjects[0]) : "");
  }, [selectedProjectKey, sortedProjects]);

  const selectedProject = sortedProjects.find(
    (project) => projectKey(project) === selectedProjectKey,
  );
  const scan = useEnvironmentQuery(
    selectedProject
      ? orchestrationEnvironment.threadImportScan({
          environmentId: selectedProject.environmentId,
          input: { projectId: selectedProject.id },
        })
      : null,
  );
  const candidates = scan.data?.candidates ?? [];

  useEffect(() => {
    setSelectedCandidateIds(new Set());
    setCommitError(null);
  }, [selectedProjectKey]);

  const toggleCandidate = (candidateId: string) => {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  };

  const importSelected = async () => {
    if (!selectedProject || selectedCandidateIds.size === 0) return;
    setCommitError(null);
    setIsImporting(true);
    try {
      const result = await commitImports({
        environmentId: selectedProject.environmentId,
        input: {
          projectId: selectedProject.id,
          candidateIds: [...selectedCandidateIds] as ThreadImportCandidate["candidateId"][],
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        },
      });
      if (result._tag === "Failure") {
        setCommitError(errorMessage(squashAtomCommandFailure(result)));
        return;
      }
      const firstThread = (result.value as ThreadImportCommitResult).results.find(
        (item) => item.threadId !== null,
      );
      if (firstThread?.threadId) {
        navigation.navigate("Thread", {
          environmentId: selectedProject.environmentId,
          threadId: firstThread.threadId,
        });
      } else {
        navigation.goBack();
      }
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-5 px-5 py-5"
      refreshControl={<RefreshControl refreshing={scan.isPending} onRefresh={scan.refresh} />}
    >
      <View className="gap-2">
        <Text className="text-sm leading-5 text-foreground-muted">
          Choose a primary project. Discovery runs on that remote T3 server host, and only exact
          workspace matches are eligible.
        </Text>
        {sortedProjects.length === 0 ? (
          <Text className="py-8 text-center text-base text-foreground-muted">
            Connect an environment with a project first.
          </Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {sortedProjects.map((project) => {
              const selected = projectKey(project) === selectedProjectKey;
              return (
                <Pressable
                  key={projectKey(project)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setSelectedProjectKey(projectKey(project))}
                  className={
                    selected
                      ? "rounded-xl bg-primary px-3.5 py-2.5"
                      : "rounded-xl border border-input-border bg-card px-3.5 py-2.5"
                  }
                >
                  <Text
                    className={
                      selected
                        ? "font-t3-bold text-primary-foreground"
                        : "font-t3-medium text-foreground"
                    }
                  >
                    {project.title}
                  </Text>
                  <Text
                    className={
                      selected
                        ? "mt-0.5 text-xs text-primary-foreground/75"
                        : "mt-0.5 text-xs text-foreground-muted"
                    }
                  >
                    {project.environmentId}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      {scan.error ? <ErrorBanner message={scan.error} /> : null}
      {commitError ? <ErrorBanner message={commitError} /> : null}
      {scan.isPending ? (
        <View className="items-center gap-3 py-12">
          <ActivityIndicator />
          <Text className="text-sm text-foreground-muted">Scanning provider histories…</Text>
        </View>
      ) : candidates.length === 0 && selectedProject ? (
        <Text className="rounded-2xl border border-dashed border-input-border px-5 py-10 text-center text-sm text-foreground-muted">
          No eligible conversations found.
        </Text>
      ) : (
        <View className="gap-2">
          {candidates.map((candidate) => {
            const selected = selectedCandidateIds.has(candidate.candidateId);
            return (
              <Pressable
                key={candidate.candidateId}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled: candidate.alreadyImported }}
                disabled={candidate.alreadyImported}
                onPress={() => toggleCandidate(candidate.candidateId)}
                className={
                  selected
                    ? "rounded-2xl border border-primary bg-primary/10 px-4 py-3"
                    : "rounded-2xl border border-input-border bg-card px-4 py-3"
                }
              >
                <View className="flex-row items-start gap-3">
                  <View
                    className={
                      selected
                        ? "mt-0.5 size-5 items-center justify-center rounded-md bg-primary"
                        : "mt-0.5 size-5 rounded-md border border-input-border"
                    }
                  >
                    {selected ? (
                      <Text className="text-xs font-t3-bold text-primary-foreground">✓</Text>
                    ) : null}
                  </View>
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="font-t3-bold text-sm text-foreground">{candidate.title}</Text>
                    <Text className="text-xs text-foreground-muted">
                      {providerLabel(candidate.provider)} · {candidate.messageCount} messages ·{" "}
                      {formatUpdatedAt(candidate.updatedAt)} ·{" "}
                      {candidate.canResume ? "Resume available" : "Transcript only"}
                    </Text>
                    {candidate.alreadyImported ? (
                      <Text className="text-xs text-foreground-muted">Already imported</Text>
                    ) : null}
                    {candidate.warnings.length > 0 ? (
                      <Text className="text-xs text-warning">{candidate.warnings.join(" ")}</Text>
                    ) : null}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        disabled={selectedCandidateIds.size === 0 || scan.isPending || isImporting}
        onPress={() => void importSelected()}
        className={
          selectedCandidateIds.size > 0 && !scan.isPending && !isImporting
            ? "items-center rounded-xl bg-primary px-4 py-3.5"
            : "items-center rounded-xl bg-subtle px-4 py-3.5 opacity-50"
        }
      >
        <Text className="font-t3-bold text-base text-primary-foreground">
          {isImporting
            ? "Importing…"
            : `Import ${selectedCandidateIds.size > 0 ? `(${selectedCandidateIds.size})` : "conversations"}`}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
