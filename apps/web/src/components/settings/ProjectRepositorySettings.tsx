import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import {
  isMissingProjectConfig,
  parseRepositoryPaths,
  updateRepositoryConfig,
} from "./ProjectRepositorySettings.logic";

function readContents(result: AsyncResult.AsyncResult<ProjectReadFileResult, unknown>): string {
  if (result._tag === "Failure") {
    const error = Cause.squash(result.cause);
    if (isMissingProjectConfig(error)) return "{}\n";
    throw new Error("Could not read t3.json. Check access to this checkout and reload.");
  }
  if (result._tag !== "Success") throw new Error("Loading t3.json…");
  if (result.value.truncated) throw new Error("t3.json is too large to edit in settings.");
  return result.value.contents;
}

export function ProjectRepositorySettings({
  environmentId,
  cwd,
}: {
  environmentId: EnvironmentId;
  cwd: string;
}) {
  const fileAtom = projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: T3_PROJECT_FILE_NAME },
  });
  const result = useAtomValue(fileAtom);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const [pathsDraft, setPathsDraft] = useState<string | null>(null);
  const [submodulesDraft, setSubmodulesDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  let contents = "{}";
  let loadError: string | null = null;
  try {
    contents = readContents(result);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not read t3.json.";
  }
  const file = parseT3ProjectFile(contents);
  if (!loadError && file === null)
    loadError = "Fix the invalid t3.json before editing repository settings.";
  const paths = pathsDraft ?? file?.repositories?.paths?.join("\n") ?? "";
  const includeSubmodules = submodulesDraft ?? file?.repositories?.includeSubmodules ?? false;
  const dirty = pathsDraft !== null || submodulesDraft !== null;
  const disabled = saving || loadError !== null;
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const settings = {
        ...(pathsDraft !== null ? { paths: parseRepositoryPaths(pathsDraft) } : {}),
        ...(submodulesDraft !== null ? { includeSubmodules: submodulesDraft } : {}),
      };
      appAtomRegistry.refresh(fileAtom);
      const fresh = await executeAtomQuery(appAtomRegistry, fileAtom, {
        reportFailure: false,
        reportDefect: false,
      });
      const freshContents = readContents(fresh);
      const updated = updateRepositoryConfig(freshContents, settings);
      const written = await writeFile({
        environmentId,
        input: {
          cwd,
          relativePath: T3_PROJECT_FILE_NAME,
          contents: updated,
          expectedContents: fresh._tag === "Success" ? freshContents : null,
        },
      });
      if (written._tag !== "Success") throw squashAtomCommandFailure(written);
      appAtomRegistry.refresh(fileAtom);
      await executeAtomQuery(appAtomRegistry, fileAtom, {
        reportFailure: false,
        reportDefect: false,
      });
      appAtomRegistry.refresh(
        projectEnvironment.listRepositories({ environmentId, input: { cwd } }),
      );
      appAtomRegistry.refresh(projectEnvironment.listEntries({ environmentId, input: { cwd } }));
      setPathsDraft(null);
      setSubmodulesDraft(null);
      setSaveMessage("Saved to this checkout’s t3.json.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save repository settings.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SettingsRow
        title="Repository paths"
        description="One relative path per line. Use projects/* to include immediate child repositories. Saved in this checkout’s t3.json; other worktrees are not discovered."
        control={
          <Textarea
            aria-label="Repository paths"
            placeholder="projects/*"
            value={paths}
            disabled={disabled}
            rows={3}
            className="w-full sm:w-80 font-mono text-sm"
            onChange={(event) => {
              setPathsDraft(event.target.value);
              setSaveMessage(null);
              setSaveError(null);
            }}
          />
        }
      />
      <SettingsRow
        title="Include Git submodules"
        description="Include repositories declared in .gitmodules. Uninitialized submodules appear as unavailable."
        control={
          <Switch
            aria-label="Include Git submodules"
            checked={includeSubmodules}
            disabled={disabled}
            onCheckedChange={(value) => {
              setSubmodulesDraft(value);
              setSaveMessage(null);
              setSaveError(null);
            }}
          />
        }
      />
      <div className="flex flex-wrap items-center justify-end gap-3 px-4 py-3">
        {loadError || saveError ? (
          <p role="alert" className="mr-auto text-sm text-error">
            {loadError ?? saveError}
          </p>
        ) : saveMessage ? (
          <p role="status" className="mr-auto text-sm text-muted-foreground">
            {saveMessage}
          </p>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            setPathsDraft(null);
            setSubmodulesDraft(null);
            setSaveError(null);
            setSaveMessage(null);
            appAtomRegistry.refresh(fileAtom);
          }}
        >
          Reload
        </Button>
        <Button size="sm" disabled={disabled || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save repository settings"}
        </Button>
      </div>
    </>
  );
}
