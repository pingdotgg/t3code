import type { EnvironmentId, SkillInstallTarget, SkillPreviewItem } from "@t3tools/contracts";
import { useId, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";

/**
 * Install skills from a source, as `npx skills add` does: paste the source,
 * pick from the skills it holds, install for every agent at the current scope.
 */
export function AddSkillsDialog({
  open,
  onOpenChange,
  environmentId,
  target,
  scopeLabel,
  onInstalled,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly target: SkillInstallTarget;
  /** Where the skills go, e.g. "This Mac" or a project name. */
  readonly scopeLabel: string;
  readonly onInstalled: () => void;
}) {
  const id = useId();
  const preview = useAtomCommand(serverEnvironment.previewSkills, { reportFailure: false });
  const install = useAtomCommand(serverEnvironment.installSkills, { reportFailure: false });
  const [source, setSource] = useState("");
  const [found, setFound] = useState<{
    readonly source: string;
    readonly skills: ReadonlyArray<SkillPreviewItem>;
  } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"finding" | "installing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    const trimmed = source.trim();
    if (trimmed.length === 0 || busy !== null) return;
    setBusy("finding");
    setError(null);
    const result = await preview({ environmentId, input: { source: trimmed } });
    setBusy(null);
    if (result._tag === "Failure") {
      setFound(null);
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    setFound({ source: trimmed, skills: result.value.skills });
    setSelected(new Set(result.value.skills.map((skill) => skill.name)));
  };

  const installSelected = async () => {
    if (found === null || selected.size === 0 || busy !== null) return;
    setBusy("installing");
    setError(null);
    const result = await install({
      environmentId,
      input: { source: found.source, skills: [...selected], target },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    const failed = result.value.outcomes.filter((outcome) => outcome.status !== "installed");
    onInstalled();
    if (failed.length > 0) {
      setError(
        failed
          .map((outcome) => `${outcome.name || found.source}: ${outcome.error ?? outcome.status}`)
          .join("\n"),
      );
      return;
    }
    onOpenChange(false);
  };

  const toggle = (name: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy === null) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add skills</DialogTitle>
          <DialogDescription>
            Installs for every agent on {scopeLabel}, the same way <code>npx skills add</code> does.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void find();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-source`}>Source</Label>
              <div className="flex gap-2">
                <Input
                  id={`${id}-source`}
                  className="min-w-0 flex-1"
                  font="mono"
                  placeholder="owner/repo"
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                    setFound(null);
                  }}
                  spellCheck={false}
                  autoFocus
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={busy !== null || source.trim().length === 0}
                >
                  {busy === "finding" ? <Spinner /> : null}
                  Find skills
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                A GitHub <code>owner/repo</code>, a git URL, or a folder on the environment.
              </p>
            </div>
            {found !== null ? (
              <fieldset className="grid gap-1">
                <legend className="mb-1.5 text-sm font-medium">
                  {found.skills.length === 1 ? "1 skill" : `${found.skills.length} skills`}
                </legend>
                <div className="max-h-72 overflow-y-auto rounded-lg border">
                  {found.skills.map((skill) => (
                    <label
                      key={skill.name}
                      className="flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.has(skill.name)}
                        onCheckedChange={(checked) => toggle(skill.name, checked === true)}
                      />
                      <span className="grid min-w-0 gap-0.5">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-sm">{skill.name}</span>
                          {skill.scripts ? (
                            <Badge variant="warning" size="sm">
                              Includes scripts
                            </Badge>
                          ) : null}
                        </span>
                        {skill.description ? (
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {skill.description}
                          </span>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                          {skill.files.length === 1 ? "1 file" : `${skill.files.length} files`}
                          {skill.filesTruncated ? " or more" : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Skills can tell agents to run their scripts. Install only sources you trust.
                </p>
              </fieldset>
            ) : null}
            {error !== null ? (
              <p className="whitespace-pre-line text-xs text-destructive-foreground">{error}</p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy !== null} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={found === null || selected.size === 0 || busy !== null}
            onClick={() => void installSelected()}
          >
            {busy === "installing" ? <Spinner /> : null}
            {selected.size > 1 ? `Install ${selected.size} skills` : "Install"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
