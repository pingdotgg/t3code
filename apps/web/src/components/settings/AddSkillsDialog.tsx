import {
  type EnvironmentId,
  MAX_SKILLS_PER_INSTALL,
  type SkillInstallTarget,
  type SkillPreviewItem,
} from "@t3tools/contracts";
import { AlertTriangleIcon, SearchIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TruncatedText } from "./TruncatedText";

/** A source this big gets a filter above its list. */
const FILTER_FROM = 8;

/**
 * Install skills from a source, as `npx skills add` does: paste the source,
 * pick from the skills it holds, install for every agent at the current scope.
 * The picker uses the Skills list's dense one-line rows.
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
  const [filter, setFilter] = useState("");
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
    setFilter("");
    // Everything is ticked, up to what one install takes.
    setSelected(
      new Set(result.value.skills.slice(0, MAX_SKILLS_PER_INSTALL).map((skill) => skill.name)),
    );
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
      if (checked && current.size >= MAX_SKILLS_PER_INSTALL) return current;
      const next = new Set(current);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  const full = selected.size >= MAX_SKILLS_PER_INSTALL;
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (found === null || needle.length === 0) return found?.skills ?? [];
    return found.skills.filter(
      (skill) =>
        skill.folder.toLowerCase().includes(needle) ||
        skill.name.toLowerCase().includes(needle) ||
        (skill.description ?? "").toLowerCase().includes(needle),
    );
  }, [filter, found]);
  // The header box acts on the rows shown, so a filter can pick a subset.
  const shownSelected = shown.filter((skill) => selected.has(skill.name)).length;
  const allShown = shown.length > 0 && shownSelected === shown.length;
  const selectShown = (checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const skill of shown) {
        if (!checked) next.delete(skill.name);
        else if (next.size < MAX_SKILLS_PER_INSTALL) next.add(skill.name);
      }
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy === null) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-xl">
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
                  // The preview answers for the source it was asked about.
                  disabled={busy !== null}
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
              <fieldset className="grid gap-2">
                <legend className="sr-only">Skills in {found.source}</legend>
                {found.skills.length >= FILTER_FROM ? (
                  <InputGroup>
                    <InputGroupAddon>
                      <SearchIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      size="sm"
                      placeholder={`Filter ${found.skills.length} skills…`}
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      aria-label="Filter skills"
                    />
                  </InputGroup>
                ) : null}
                <div className="overflow-hidden rounded-lg border">
                  <label className="flex items-center gap-3 border-b bg-muted/25 px-3 py-1.5 text-xs text-muted-foreground">
                    <Checkbox
                      checked={allShown}
                      indeterminate={shownSelected > 0 && !allShown}
                      disabled={shown.length === 0}
                      onCheckedChange={(checked) => selectShown(checked === true)}
                    />
                    <span className="flex-1">
                      {filter.trim() === "" ? "Select all" : "Select all shown"}
                    </span>
                    <span>
                      {selected.size} of {found.skills.length} selected
                    </span>
                  </label>
                  <ul className="max-h-[min(24rem,50vh)] divide-y divide-border/50 overflow-y-auto">
                    {shown.length === 0 ? (
                      <li className="px-3 py-4 text-sm text-muted-foreground">
                        No skills match “{filter.trim()}”.
                      </li>
                    ) : null}
                    {shown.map((skill) => (
                      <li key={skill.name}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
                          <Checkbox
                            checked={selected.has(skill.name)}
                            disabled={full && !selected.has(skill.name)}
                            onCheckedChange={(checked) => toggle(skill.name, checked === true)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {skill.folder}
                            </span>
                            <TruncatedText
                              className="text-xs text-muted-foreground"
                              text={skill.description || "No description."}
                            />
                          </span>
                          {skill.scripts ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="inline-flex shrink-0 text-warning-foreground" />
                                }
                              >
                                <AlertTriangleIcon
                                  aria-label="Includes scripts"
                                  className="size-4"
                                />
                              </TooltipTrigger>
                              <TooltipPopup side="top">Includes scripts</TooltipPopup>
                            </Tooltip>
                          ) : null}
                          <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                            {skill.files.length === 1 ? "1 file" : `${skill.files.length} files`}
                            {skill.filesTruncated ? "+" : ""}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
                {found.skills.length > MAX_SKILLS_PER_INSTALL ? (
                  <p className="text-xs text-muted-foreground">
                    One install takes up to {MAX_SKILLS_PER_INSTALL} skills. Install the rest
                    afterwards.
                  </p>
                ) : null}
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <AlertTriangleIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-warning-foreground"
                  />
                  marks skills with scripts agents can be told to run. Install only sources you
                  trust.
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
