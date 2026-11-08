import { type ServerSettingsPatch, type ToolPreset, ToolPresetName } from "@t3tools/contracts";
import { ChevronRightIcon, PlusIcon, SearchIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useId, useState, type ReactNode } from "react";

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
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { TruncatedText } from "./TruncatedText";

/** A list this long gets a filter above it. */
const FILTER_FROM = 8;

const isToolPresetName = Schema.is(ToolPresetName);

/** A skill or server a preset can hold, as the editor lists it. */
export interface ToolPresetMember {
  readonly name: string;
  readonly detail: string;
}

/**
 * Settings → Tools → Presets: named sets of skills and MCP servers that a
 * thread turns on or off together from the composer. A preset belongs to the
 * environment, so every project there shares it.
 */
export function ToolPresetsPanel({
  tabs,
  presets,
  skills,
  servers,
  canWrite,
  onWrite,
}: {
  readonly tabs: ReactNode;
  readonly presets: Readonly<Record<string, ToolPreset>>;
  readonly skills: ReadonlyArray<ToolPresetMember>;
  readonly servers: ReadonlyArray<ToolPresetMember>;
  readonly canWrite: boolean;
  /** Writes to each environment in scope, at the environment level: a project's threads use its presets too. */
  readonly onWrite: (patch: NonNullable<ServerSettingsPatch["toolPresets"]>) => void;
}) {
  const [editing, setEditing] = useState<{ readonly name: string | null } | null>(null);
  const names = Object.keys(presets).toSorted((left, right) => left.localeCompare(right));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
        {tabs}
        {canWrite ? (
          <Button size="sm" variant="outline" onClick={() => setEditing({ name: null })}>
            <PlusIcon className="size-3.5" aria-hidden />
            New preset
          </Button>
        ) : null}
      </div>
      <SettingsSection {...searchableSetting("tools-presets")} hideTitle>
        {names.length === 0 ? (
          <SettingsRow
            title="No presets yet"
            description="Group skills and MCP servers you use together, then turn them on or off for a thread from the composer."
          />
        ) : (
          names.map((name) => (
            <SettingsRow
              key={name}
              onClick={canWrite ? () => setEditing({ name }) : undefined}
              className={canWrite ? "cursor-pointer hover:bg-muted/40" : undefined}
              title={
                canWrite ? (
                  <button
                    type="button"
                    aria-label={`Edit ${name}`}
                    className="truncate rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    {name}
                  </button>
                ) : (
                  name
                )
              }
              description={presetSummary(presets[name]!)}
              control={
                canWrite ? (
                  <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                ) : undefined
              }
            />
          ))
        )}
      </SettingsSection>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Turn a preset on or off for one thread from the composer's Tools menu; the thread's next
        message starts with those tools. Every project on the environment shares its presets.
      </p>
      {editing !== null ? (
        <ToolPresetDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          name={editing.name}
          preset={editing.name === null ? null : (presets[editing.name] ?? null)}
          takenNames={new Set(names.filter((name) => name !== editing.name))}
          skills={skills}
          servers={servers}
          onSave={(name, preset) => {
            onWrite({
              ...(editing.name !== null && editing.name !== name ? { [editing.name]: null } : {}),
              [name]: preset,
            });
            setEditing(null);
          }}
          onDelete={
            editing.name === null
              ? null
              : () => {
                  onWrite({ [editing.name!]: null });
                  setEditing(null);
                }
          }
        />
      ) : null}
    </>
  );
}

function presetSummary(preset: ToolPreset): string {
  const parts = [
    preset.skills.length > 0 ? `Skills: ${preset.skills.join(", ")}` : null,
    preset.mcpServers.length > 0 ? `Servers: ${preset.mcpServers.join(", ")}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Empty" : parts.join(" · ");
}

function ToolPresetDialog({
  open,
  onOpenChange,
  name: initialName,
  preset,
  takenNames,
  skills,
  servers,
  onSave,
  onDelete,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly name: string | null;
  readonly preset: ToolPreset | null;
  readonly takenNames: ReadonlySet<string>;
  readonly skills: ReadonlyArray<ToolPresetMember>;
  readonly servers: ReadonlyArray<ToolPresetMember>;
  readonly onSave: (name: string, preset: ToolPreset) => void;
  readonly onDelete: (() => void) | null;
}) {
  const id = useId();
  const [name, setName] = useState(initialName ?? "");
  const [chosenSkills, setChosenSkills] = useState<ReadonlySet<string>>(
    new Set(preset?.skills ?? []),
  );
  const [chosenServers, setChosenServers] = useState<ReadonlySet<string>>(
    new Set(preset?.mcpServers ?? []),
  );
  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? null
      : takenNames.has(trimmed)
        ? "Another preset has this name."
        : isToolPresetName(trimmed)
          ? null
          : "Use at most 48 characters.";
  const canSave =
    trimmed.length > 0 && nameError === null && chosenSkills.size + chosenServers.size > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{initialName === null ? "New preset" : `Edit ${initialName}`}</DialogTitle>
          <DialogDescription>
            Pick the skills and servers a thread turns on or off together.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave) return;
              onSave(trimmed, {
                skills: [...chosenSkills].toSorted(),
                mcpServers: [...chosenServers].toSorted(),
              });
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
              emptyText="No skills on this environment."
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
          {onDelete !== null ? (
            <Button variant="destructive-outline" className="sm:me-auto" onClick={onDelete}>
              Delete
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() =>
              onSave(trimmed, {
                skills: [...chosenSkills].toSorted(),
                mcpServers: [...chosenServers].toSorted(),
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The listed members plus any the preset holds that the environment no longer has. */
function withChosen(
  members: ReadonlyArray<ToolPresetMember>,
  chosen: ReadonlySet<string>,
): ReadonlyArray<ToolPresetMember> {
  const listed = new Set(members.map((member) => member.name.toLowerCase()));
  return [
    ...members,
    ...[...chosen]
      .filter((name) => !listed.has(name.toLowerCase()))
      .map((name) => ({ name, detail: "Not on this environment" })),
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
