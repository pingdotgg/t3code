import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { randomUUID } from "~/lib/utils";
import { useGT } from "gt-react";
import {
  CommandId,
  type BotAccess,
  type BotProfile,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { BotIcon, ChevronRightIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SidebarGroup } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { SidebarBotWork } from "./SidebarBotWork";
import { SidebarBotDrafts } from "./SidebarBotDrafts";

const emptyProfile = {
  name: "",
  role: "",
  description: "",
  icon: "",
  color: "#6366f1",
  instructions: "",
};

export function SidebarBots(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly openThread: (thread: ScopedThreadRef) => unknown;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(true);

  if (props.environmentIds.length === 0) return null;
  return (
    <SidebarGroup>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRightIcon className={expanded ? "rotate-90" : undefined} />
        {gt("Bots")}
      </Button>
      {expanded &&
        props.environmentIds.map((environmentId) => (
          <EnvironmentBots
            key={environmentId}
            environmentId={environmentId}
            openThread={props.openThread}
          />
        ))}
    </SidebarGroup>
  );
}

function EnvironmentBots(props: {
  readonly environmentId: EnvironmentId;
  readonly openThread: (thread: ScopedThreadRef) => unknown;
}) {
  const gt = useGT();
  const { environmentId } = props;
  const live = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const canCreate = useAtomValue(serverEnvironment.createBot.permissionAtom(environmentId));
  const canEdit = useAtomValue(serverEnvironment.updateBot.permissionAtom(environmentId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [editing, setEditing] = useState<BotProfile | "new" | null>(null);
  if (!live.data) return null;

  return (
    <>
      {live.data.map((bot) => (
        <div key={bot.threadId} className="group flex min-w-0 items-center gap-1 px-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
            onClick={() => props.openThread(scopeThreadRef(environmentId, bot.threadId))}
          >
            <span className="shrink-0" style={{ color: bot.color }} aria-hidden>
              {bot.icon || <BotIcon className="size-4" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate">{bot.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {projects.find((project) => project.id === bot.projectId)?.title}
                {bot.state === "paused" && ` · ${gt("Paused")}`}
                {bot.state === "archived" && ` · ${gt("Archived")}`}
              </span>
            </span>
          </button>
          {canEdit && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={gt("Edit bot")}
              onClick={() => setEditing(bot)}
            >
              <SettingsIcon />
            </Button>
          )}
        </div>
      ))}
      {canCreate && (
        <Button variant="ghost" size="sm" onClick={() => setEditing("new")}>
          <PlusIcon />
          {gt("New bot")}
        </Button>
      )}
      {canEdit && <SidebarBotDrafts environmentId={environmentId} bots={live.data} />}
      {canEdit && (
        <SidebarBotWork
          environmentId={environmentId}
          bots={live.data}
          openThread={props.openThread}
        />
      )}
      {editing !== null && (
        <BotEditor
          environmentId={environmentId}
          bot={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onCreate={(bot) => props.openThread(scopeThreadRef(environmentId, bot.threadId))}
        />
      )}
    </>
  );
}

function BotEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotProfile | undefined;
  readonly onClose: () => void;
  readonly onCreate: (bot: BotProfile) => unknown;
}) {
  const gt = useGT();
  const { bot, environmentId } = props;
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId && !project.archivedAt && !project.isScratch,
  );
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const models = (providers ?? [])
    .filter(
      (provider) =>
        provider.enabled && (provider.driver === "codex" || provider.instanceId === "devReplay"),
    )
    .flatMap((provider) =>
      provider.models.map((model) => ({
        label: `${provider.displayName ?? provider.driver} · ${model.name}`,
        instanceId: provider.instanceId,
        model: model.slug,
      })),
    );
  const [projectId, setProjectId] = useState(bot?.projectId ?? projects[0]?.id ?? "");
  const [modelIndex, setModelIndex] = useState(0);
  const [commandId] = useState(() => CommandId.make(randomUUID()));
  const [profile, setProfile] = useState(() =>
    bot === undefined
      ? emptyProfile
      : {
          name: bot.name,
          role: bot.role,
          description: bot.description,
          icon: bot.icon,
          color: bot.color,
          instructions: bot.instructions,
        },
  );
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [access, setAccess] = useState<BotAccess>(
    bot?.access ?? { writeSources: [], handoffProjects: [] },
  );
  const history = useEnvironmentQuery(
    showHistory && bot
      ? serverEnvironment.botHistory({ environmentId, input: { threadId: bot.threadId } })
      : null,
  );
  const create = useAtomCommand(serverEnvironment.createBot);
  const update = useAtomCommand(serverEnvironment.updateBot);
  const setState = useAtomCommand(serverEnvironment.setBotState);
  const saveAccess = useAtomCommand(serverEnvironment.setBotAccess);
  const restore = useAtomCommand(serverEnvironment.restoreBot);
  const project = projects.find((item) => item.id === projectId);
  const selection = models[modelIndex];

  async function save() {
    if (busy || !profile.name.trim()) return;
    const fields = { ...profile, name: profile.name.trim() };
    if (bot === undefined && (!project || !selection)) return;
    setBusy(true);
    const result =
      bot !== undefined
        ? await update({
            environmentId,
            input: { threadId: bot.threadId, expectedRevision: bot.revision, profile: fields },
          })
        : project && selection
          ? await create({
              environmentId,
              input: {
                commandId,
                projectId: project.id,
                modelSelection: { instanceId: selection.instanceId, model: selection.model },
                profile: fields,
              },
            })
          : undefined;
    setBusy(false);
    if (result?._tag === "Success") {
      props.onClose();
      if (!bot) props.onCreate(result.value);
    }
  }

  const shownFields = [
    { key: "name", label: gt("Name"), maxLength: 80 },
    { key: "role", label: gt("Role"), maxLength: 120 },
    { key: "description", label: gt("Description"), maxLength: 500 },
    { key: "icon", label: gt("Icon"), maxLength: 16 },
  ] as const;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{bot ? gt("Edit bot") : gt("New bot")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-3">
              {bot === undefined && (
                <>
                  <label className="grid gap-1 text-sm">
                    {gt("Project")}
                    <select
                      className="rounded-md border bg-background p-2"
                      value={projectId}
                      onChange={(event) => setProjectId(event.target.value)}
                    >
                      {projects.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm">
                    {gt("Model")}
                    <select
                      className="rounded-md border bg-background p-2"
                      value={modelIndex}
                      onChange={(event) => setModelIndex(Number(event.target.value))}
                    >
                      {models.map((item, index) => (
                        <option key={JSON.stringify([item.instanceId, item.model])} value={index}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {models.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {gt("Enable a Codex provider to create a bot.")}
                    </p>
                  )}
                </>
              )}
              {shownFields.map(({ key, label, maxLength }) => (
                <label className="grid gap-1 text-sm" key={key}>
                  {label}
                  <Input
                    required={key === "name"}
                    value={profile[key]}
                    maxLength={maxLength}
                    onChange={(event) => setProfile({ ...profile, [key]: event.target.value })}
                  />
                </label>
              ))}
              <label className="grid gap-1 text-sm">
                {gt("Color")}
                <input
                  type="color"
                  value={profile.color}
                  onChange={(event) => setProfile({ ...profile, color: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {gt("Standing instructions")}
                <Textarea
                  rows={5}
                  maxLength={3000}
                  value={profile.instructions}
                  onChange={(event) => setProfile({ ...profile, instructions: event.target.value })}
                />
              </label>
              {bot && (
                <div className="flex flex-wrap gap-2">
                  {(bot.state === "active"
                    ? (["paused", "archived"] as const)
                    : (["active"] as const)
                  ).map((state) => (
                    <Button
                      key={state}
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const result = await setState({
                          environmentId,
                          input: { threadId: bot.threadId, state },
                        });
                        setBusy(false);
                        if (result._tag === "Success") props.onClose();
                      }}
                    >
                      {state === "paused"
                        ? gt("Pause")
                        : state === "archived"
                          ? gt("Archive")
                          : gt("Resume")}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowHistory(!showHistory)}
                  >
                    {gt("Version history")}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setShowAccess(!showAccess)}>
                    {gt("Permissions")}
                  </Button>
                </div>
              )}
              {bot && showAccess && (
                <div className="grid gap-3 rounded-md border p-3">
                  <fieldset className="grid gap-2 text-sm">
                    <legend>{gt("Allow workspace writes from")}</legend>
                    {(
                      [
                        { value: "scheduled", label: gt("Scheduled tasks") },
                        { value: "handoff", label: gt("Thread handoffs") },
                        { value: "webhook", label: gt("Webhooks") },
                      ] as const
                    ).map(({ value, label }) => (
                      <label key={value} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={access.writeSources.includes(value)}
                          onChange={(event) =>
                            setAccess({
                              ...access,
                              writeSources: event.target.checked
                                ? [...access.writeSources, value]
                                : access.writeSources.filter((source) => source !== value),
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                  {projects.some((item) => item.id !== bot.projectId) && (
                    <fieldset className="grid gap-2 text-sm">
                      <legend>{gt("Accept handoffs from other projects")}</legend>
                      {projects
                        .filter((item) => item.id !== bot.projectId)
                        .map((item) => (
                          <label key={item.id} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={access.handoffProjects.includes(item.id)}
                              onChange={(event) =>
                                setAccess({
                                  ...access,
                                  handoffProjects: event.target.checked
                                    ? [...access.handoffProjects, item.id]
                                    : access.handoffProjects.filter((id) => id !== item.id),
                                })
                              }
                            />
                            {item.title}
                          </label>
                        ))}
                    </fieldset>
                  )}
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const result = await saveAccess({
                          environmentId,
                          input: { threadId: bot.threadId, access },
                        });
                        setBusy(false);
                        if (result._tag === "Success") setShowAccess(false);
                      }}
                    >
                      {gt("Save permissions")}
                    </Button>
                  </div>
                </div>
              )}
              {bot &&
                showHistory &&
                history.data
                  ?.filter((version) => version.revision !== bot.revision)
                  .map((version) => (
                    <div className="grid gap-1 rounded-md border p-2" key={version.revision}>
                      <p className="text-sm">
                        {gt("Revision {number}", { number: version.revision })} · {version.name}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {version.instructions}
                      </p>
                      <div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            const result = await restore({
                              environmentId,
                              input: {
                                threadId: bot.threadId,
                                revision: version.revision,
                                expectedRevision: bot.revision,
                              },
                            });
                            setBusy(false);
                            if (result._tag === "Success") props.onClose();
                          }}
                        >
                          {gt("Restore")}
                        </Button>
                      </div>
                    </div>
                  ))}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              {gt("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={busy || !profile.name.trim() || (!bot && (!project || !selection))}
            >
              {gt("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
