import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useId, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  CLAUDE_INSTRUCTIONS_IMPORT,
  CLAUDE_INSTRUCTIONS_PATH,
  PROJECT_INSTRUCTIONS_PATH,
} from "./projectCoordinator.logic";

export interface ProjectInstructionsTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectTitle: string;
  readonly contents: string;
  readonly exists: boolean;
}

/** Claude reads CLAUDE.md, so a project without one gets a stub importing AGENTS.md. */
async function linkClaudeInstructions(target: ProjectInstructionsTarget) {
  const existing = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFile({
      environmentId: target.environmentId,
      input: { cwd: target.cwd, relativePath: CLAUDE_INSTRUCTIONS_PATH, allowMissing: true },
    }),
    { label: "Read Claude instructions", reportFailure: false, refresh: true },
  );
  if (existing._tag === "Failure" || existing.value.exists !== false) return;
  await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.writeFile,
    {
      environmentId: target.environmentId,
      input: {
        cwd: target.cwd,
        relativePath: CLAUDE_INSTRUCTIONS_PATH,
        contents: CLAUDE_INSTRUCTIONS_IMPORT,
      },
    },
    { label: "Link Claude instructions", reportFailure: false },
  );
}

/** Edits the project's AGENTS.md, which the coordinator and its agents read at session start. */
export function ProjectInstructionsDialog(props: {
  readonly target: ProjectInstructionsTarget;
  readonly onClose: () => void;
}) {
  const id = useId();
  const { target } = props;
  const [contents, setContents] = useState(target.contents);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const result = await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.writeFile,
      {
        environmentId: target.environmentId,
        input: { cwd: target.cwd, relativePath: PROJECT_INSTRUCTIONS_PATH, contents },
      },
      { label: "Save project instructions", reportFailure: false },
    );
    if (result._tag === "Success") await linkClaudeInstructions(target);
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save instructions",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Instructions saved",
      description: "New agent sessions in this project read them.",
    });
    props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Project instructions</DialogTitle>
            <DialogDescription>
              {target.exists ? "Edits" : "Creates"} {PROJECT_INSTRUCTIONS_PATH} in{" "}
              {target.projectTitle}. The coordinator and every agent thread read it when a session
              starts.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-instructions`}>{PROJECT_INSTRUCTIONS_PATH}</Label>
              <Textarea
                id={`${id}-instructions`}
                rows={14}
                value={contents}
                placeholder="How agents should work in this project: conventions, commands to run, things to avoid."
                onChange={(event) => setContents(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
