import {
  type EnvironmentId,
  mcpServerTransportSummary,
  type ProjectId,
  type ServerProvider,
  type ToolPreset,
  ToolPresetName,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { SearchIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCheckoutScans } from "../settings/SkillEnvironments";
import { collectSkillRows, listMcpServerRows } from "../settings/toolsSettings.logic";
import { TruncatedText } from "../settings/TruncatedText";
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

/** A list this long gets a filter above it. */
const FILTER_FROM = 8;
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

const isToolPresetName = Schema.is(ToolPresetName);

interface ToolPresetMember {
  readonly name: string;
  readonly detail: string;
}

/**
 * Create, change or delete one of the environment's tool presets from a
 * thread's composer. It lists the skills the agents find for this checkout and
 * the MCP servers settings define for the project.
 */
export function ToolPresetDialog({
  environmentId,
  projectId,
  cwd,
  name: initialName,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  /** The preset to edit, or null for a new one. */
  readonly name: string | null;
  readonly onClose: () => void;
}) {
  const id = useId();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS;
  // Servers send a checkout's skills only to a client that asks for them.
  useCheckoutScans([{ environmentId, cwd }], [{ environmentId, providers }]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update tool presets",
  });
  const presets = settings?.toolPresets ?? {};
  const preset = initialName === null ? undefined : presets[initialName];
  const [name, setName] = useState(initialName ?? "");
  const [chosenSkills, setChosenSkills] = useState<ReadonlySet<string>>(
    () => new Set(preset?.skills ?? []),
  );
  const [chosenServers, setChosenServers] = useState<ReadonlySet<string>>(
    () => new Set(preset?.mcpServers ?? []),
  );

  const skills = collectSkillRows(providers, cwd).map((row) => ({
    name: row.name,
    detail: row.description ?? "",
  }));
  const servers = listMcpServerRows({
    environment: settings?.mcpServers ?? {},
    project:
      projectId === null ? null : (settings?.projectSettingsOverrides[projectId]?.mcpServers ?? {}),
  }).map((row) => ({ name: row.name, detail: mcpServerTransportSummary(row.config.transport) }));

  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? null
      : trimmed !== initialName && Object.hasOwn(presets, trimmed)
        ? "Another preset has this name."
        : isToolPresetName(trimmed)
          ? null
          : "Use at most 48 characters.";
  const canSave =
    trimmed.length > 0 && nameError === null && chosenSkills.size + chosenServers.size > 0;

  const write = (patch: Readonly<Record<string, ToolPreset | null>>) => {
    void updateSettings({ environmentId, input: { patch: { toolPresets: patch } } });
    onClose();
  };
  const save = () => {
    if (!canSave) return;
    write({
      // A thread's switch for the old name stops applying, as after a delete.
      ...(initialName !== null && initialName !== trimmed ? { [initialName]: null } : {}),
      [trimmed]: {
        skills: [...chosenSkills].toSorted(),
        mcpServers: [...chosenServers].toSorted(),
      },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{initialName === null ? "New preset" : `Edit ${initialName}`}</DialogTitle>
          <DialogDescription>
            Pick the skills and servers a thread turns on or off together. Every project on this
            environment can use the preset.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                placeholder="Frontend"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
              {nameError !== null ? (
                <p className="text-xs text-destructive-foreground">{nameError}</p>
              ) : null}
            </div>
            <MemberList
              label="Skills"
              emptyText="The agents here have no skills."
              members={withChosen(skills, chosenSkills)}
              chosen={chosenSkills}
              onChange={setChosenSkills}
            />
            <MemberList
              label="MCP servers"
              emptyText="No MCP servers added in Settings → Tools."
              members={withChosen(servers, chosenServers)}
              chosen={chosenServers}
              onChange={setChosenServers}
            />
            {/* Enter in the name field saves. */}
            <button type="submit" hidden />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {initialName !== null ? (
            <Button
              variant="destructive-outline"
              className="sm:me-auto"
              onClick={() => write({ [initialName]: null })}
            >
              Delete
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The listed members plus any the preset holds that this project doesn't have. */
function withChosen(
  members: ReadonlyArray<ToolPresetMember>,
  chosen: ReadonlySet<string>,
): ReadonlyArray<ToolPresetMember> {
  const listed = new Set(members.map((member) => member.name.toLowerCase()));
  return [
    ...members,
    ...[...chosen]
      .filter((name) => !listed.has(name.toLowerCase()))
      .map((name) => ({ name, detail: "Not found here" })),
  ];
}

function MemberList({
  label,
  emptyText,
  members,
  chosen,
  onChange,
}: {
  readonly label: string;
  readonly emptyText: string;
  readonly members: ReadonlyArray<ToolPresetMember>;
  readonly chosen: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const shown =
    query === ""
      ? members
      : members.filter(
          (member) =>
            member.name.toLowerCase().includes(query) ||
            member.detail.toLowerCase().includes(query),
        );
  const toggle = (name: string, checked: boolean) => {
    const next = new Set(chosen);
    if (checked) next.add(name);
    else next.delete(name);
    onChange(next);
  };
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-sm font-medium">
        {label}
        {chosen.size > 0 ? (
          <span className="ms-1.5 font-normal text-muted-foreground tabular-nums">
            {chosen.size}
          </span>
        ) : null}
      </legend>
      {members.length >= FILTER_FROM ? (
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            size="sm"
            placeholder={`Filter ${members.length} ${label.toLowerCase()}…`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label={`Filter ${label.toLowerCase()}`}
          />
        </InputGroup>
      ) : null}
      <ul className="max-h-[min(16rem,35vh)] divide-y divide-border/50 overflow-y-auto rounded-lg border">
        {members.length === 0 ? (
          <li className="px-3 py-3 text-sm text-muted-foreground">{emptyText}</li>
        ) : shown.length === 0 ? (
          <li className="px-3 py-3 text-sm text-muted-foreground">
            No matches for “{filter.trim()}”.
          </li>
        ) : (
          shown.map((member) => (
            <li key={member.name}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
                <Checkbox
                  checked={chosen.has(member.name)}
                  onCheckedChange={(checked) => toggle(member.name, checked === true)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{member.name}</span>
                  {member.detail === "" ? null : (
                    <TruncatedText className="text-xs text-muted-foreground" text={member.detail} />
                  )}
                </span>
              </label>
            </li>
          ))
        )}
      </ul>
    </fieldset>
  );
}
