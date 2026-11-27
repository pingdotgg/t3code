import {
  SKILL_INJECT_TARGETS,
  type EnvironmentId,
  type SkillInjectResult,
  type SkillInjectTarget,
  type SkillLibraryEntry,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { RefreshCwIcon, UploadIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages } from "gt-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { skillsInject, skillsListLibrary, skillsReadBundle } from "../../state/skills";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsSection } from "./settingsLayout";

const TARGET_LABELS: Readonly<Record<SkillInjectTarget, string>> = {
  agents: "~/.agents/skills",
  codex: "Codex (~/.codex/skills)",
  claude: "Claude (~/.claude/skills)",
  antigravity: "Antigravity (~/.gemini/config/skills)",
  pi: "Pi (~/.pi/agent/skills)",
};

const STORAGE_KEY_LIBRARY_PATH = "t3code.skillLibrary.path";

function readSavedLibraryPath(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY_LIBRARY_PATH) ?? "";
  } catch {
    return "";
  }
}

export function SkillLibrarySettingsSection({
  environmentId,
  environmentLabel,
  readOnly,
  onInjected,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly readOnly: boolean;
  readonly onInjected?: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const sourceEnvironmentId = primaryEnvironmentId ?? environmentId;

  const [libraryPathInput, setLibraryPathInput] = useState<string>(readSavedLibraryPath);
  const [resolvedLibraryPath, setResolvedLibraryPath] = useState<string>("~/.t3/skills");
  const [libraryExists, setLibraryExists] = useState<boolean>(true);
  const [skills, setSkills] = useState<ReadonlyArray<SkillLibraryEntry>>([]);
  const [selectedSkills, setSelectedSkills] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedTargets, setSelectedTargets] = useState<ReadonlySet<SkillInjectTarget>>(
    () => new Set(SKILL_INJECT_TARGETS),
  );
  const [overwrite, setOverwrite] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isInjecting, setIsInjecting] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState<boolean>(false);
  const [lastResult, setLastResult] = useState<SkillInjectResult | null>(null);

  const loadLibrary = async (overridePath?: string) => {
    const nextPath = (overridePath ?? libraryPathInput).trim();
    setIsLoading(true);
    setLoadError(null);
    try {
      window.localStorage.setItem(STORAGE_KEY_LIBRARY_PATH, nextPath);
    } catch {
      // Ignore storage errors in restricted contexts.
    }
    try {
      const response = await runAtomCommand(appAtomRegistry, skillsListLibrary, {
        environmentId: sourceEnvironmentId,
        input: nextPath ? { libraryPath: nextPath } : {},
      });
      if (response._tag !== "Success") {
        setLoadError(gt("Failed to load skill library."));
        return;
      }
      const result = response.value;
      setHasLoaded(true);
      setResolvedLibraryPath(result.libraryPath);
      setLibraryExists(result.exists);
      setSkills(result.skills);
      setSelectedSkills((prev) => {
        const valid = new Set(result.skills.map((s) => s.name));
        const kept = [...prev].filter((name) => valid.has(name));
        return new Set(kept);
      });
    } catch (error) {
      setLoadError(thrownErrorMessage(error, m) ?? gt("Failed to load skill library."));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSkill = (name: string) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const toggleTarget = (target: SkillInjectTarget) => {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(target)) {
        next.delete(target);
      } else {
        next.add(target);
      }
      return next;
    });
  };

  const handleInject = async () => {
    if (selectedSkills.size === 0 || selectedTargets.size === 0 || readOnly) return;
    setIsInjecting(true);
    setLastResult(null);
    try {
      const trimmedPath = libraryPathInput.trim();
      const bundleResponse = await runAtomCommand(appAtomRegistry, skillsReadBundle, {
        environmentId: sourceEnvironmentId,
        input: {
          ...(trimmedPath ? { libraryPath: trimmedPath } : {}),
          names: [...selectedSkills],
        },
      });
      if (bundleResponse._tag !== "Success") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Failed to inject skills"),
            description: gt("Could not read selected skills from the library."),
          }),
        );
        return;
      }
      const injectResponse = await runAtomCommand(appAtomRegistry, skillsInject, {
        environmentId,
        input: {
          targets: [...selectedTargets],
          skills: bundleResponse.value.skills,
          overwrite,
        },
      });
      if (injectResponse._tag !== "Success") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Failed to inject skills"),
            description: gt("Could not inject skills into this environment."),
          }),
        );
        return;
      }
      const injectResult = injectResponse.value;
      setLastResult(injectResult);
      const injectedCount = injectResult.results.filter((r) => r.status === "injected").length;
      const skippedCount = injectResult.results.filter((r) => r.status === "skipped").length;
      const errorCount = injectResult.results.filter((r) => r.status === "error").length;
      toastManager.add({
        type: errorCount > 0 ? "warning" : "success",
        title: gt("Skills injected to {env}", { env: environmentLabel }),
        description: gt("{injected} injected, {skipped} skipped, {errors} failed.", {
          injected: injectedCount,
          skipped: skippedCount,
          errors: errorCount,
        }),
      });
      onInjected?.();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Failed to inject skills"),
          description:
            thrownErrorMessage(error, m) ?? gt("Could not inject skills into this environment."),
        }),
      );
    } finally {
      setIsInjecting(false);
    }
  };

  return (
    <SettingsSection title={gt("Skill library")}>
      <div className="grid gap-3 py-2">
        <p className="text-xs text-muted-foreground">
          {gt("Maintain a shared skill library and manually inject selected skills into {env}.", {
            env: environmentLabel,
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={libraryPathInput}
            onChange={(event) => setLibraryPathInput(event.target.value)}
            placeholder="~/.t3/skills"
            aria-label={gt("Skill library directory")}
            className="min-w-60 flex-1"
          />
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={isLoading}
            onClick={() => void loadLibrary()}
          >
            <RefreshCwIcon className={isLoading ? "size-3.5 animate-spin" : "size-3.5"} />
            <T>Load library</T>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {!hasLoaded
            ? gt("Click Load library to scan {path} for skills.", {
                path: libraryPathInput.trim() || resolvedLibraryPath,
              })
            : libraryExists
              ? gt("Library path: {path} ({count} skills)", {
                  path: resolvedLibraryPath,
                  count: skills.length,
                })
              : gt(
                  "Directory {path} does not exist yet. Create it with skill folders containing SKILL.md, or enter an existing library path.",
                  {
                    path: resolvedLibraryPath,
                  },
                )}
        </p>

        {loadError ? <p className="text-xs text-destructive">{loadError}</p> : null}

        {skills.length > 0 ? (
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                <T>Skills to inject</T>
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setSelectedSkills(new Set(skills.map((s) => s.name)))}
                >
                  <T>Select all</T>
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setSelectedSkills(new Set())}
                >
                  <T>Clear</T>
                </Button>
              </div>
            </div>
            <div className="grid max-h-56 gap-1.5 overflow-y-auto rounded-md border border-border/70 p-2">
              {skills.map((skill) => {
                const checked = selectedSkills.has(skill.name);
                return (
                  <label
                    key={skill.name}
                    className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSkill(skill.name)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-foreground">{skill.name}</span>
                      {skill.description ? (
                        <span className="block truncate text-muted-foreground">
                          {skill.description}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {skill.filesCount}f
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            <T>Target agent directories</T>
          </span>
          <div className="flex flex-wrap gap-2">
            {SKILL_INJECT_TARGETS.map((target) => {
              const active = selectedTargets.has(target);
              return (
                <label
                  key={target}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-xs"
                >
                  <input type="checkbox" checked={active} onChange={() => toggleTarget(target)} />
                  <span>{TARGET_LABELS[target]}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={overwrite}
              onCheckedChange={(checked) => setOverwrite(Boolean(checked))}
            />
            <T>Overwrite existing skills</T>
          </label>
          <Button
            type="button"
            size="xs"
            variant="default"
            disabled={
              readOnly || isInjecting || selectedSkills.size === 0 || selectedTargets.size === 0
            }
            onClick={() => void handleInject()}
          >
            <UploadIcon className="size-3.5" />
            {isInjecting
              ? gt("Injecting...")
              : gt("Inject {count} skills to {env}", {
                  count: selectedSkills.size,
                  env: environmentLabel,
                })}
          </Button>
        </div>

        {lastResult ? (
          <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-xs text-muted-foreground">
            {lastResult.results.map((item) => (
              <div key={`${item.skillName}:${item.target}`} className="truncate">
                <span className="font-mono text-foreground">{item.skillName}</span> → {item.target}:{" "}
                <span>{item.status}</span>
                {item.message ? ` (${item.message})` : ""}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
