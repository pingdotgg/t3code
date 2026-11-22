import { useGT } from "gt-react";
import { useState } from "react";
import type { BotDraft, BotGrant, BotProfile, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

export function SidebarBotDrafts({
  environmentId,
  bots,
}: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<BotProfile>;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const drafts = useEnvironmentQuery(
    open ? serverEnvironment.botDraftsLive({ environmentId, input: {} }) : null,
  );

  if (bots.length === 0) return null;
  const pending = drafts.data?.drafts.filter((draft) => draft.decision === undefined) ?? [];
  const visible = showHistory ? (drafts.data?.drafts ?? []) : pending;
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {gt("Bot configuration")}
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogPopup className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{gt("Bot configuration")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div className="grid gap-3">
                <BotGrants
                  environmentId={environmentId}
                  bots={bots}
                  grants={drafts.data?.grants ?? []}
                  drafts={drafts.data?.drafts ?? []}
                />
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowHistory(!showHistory)}
                  >
                    {showHistory ? gt("Pending proposals") : gt("Configuration history")}
                  </Button>
                </div>
                {drafts.data && pending.length === 0 && !showHistory && (
                  <p>{gt("No pending proposals.")}</p>
                )}
                {visible.map((draft) => (
                  <Proposal
                    key={draft.id}
                    environmentId={environmentId}
                    draft={draft}
                    author={bots.find((bot) => bot.threadId === draft.authorThreadId)}
                  />
                ))}
              </div>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}

function Proposal(props: {
  readonly environmentId: EnvironmentId;
  readonly draft: BotDraft;
  readonly author: BotProfile | undefined;
}) {
  const gt = useGT();
  const review = useAtomCommand(serverEnvironment.reviewBotDraft);
  const [busy, setBusy] = useState(false);
  const { change } = props.draft;

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    await review({ environmentId: props.environmentId, input: { id: props.draft.id, decision } });
    setBusy(false);
  }

  return (
    <article className="grid gap-2 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">
        {props.author?.name ?? props.draft.authorThreadId}
      </p>
      {props.draft.decision && (
        <p className="text-xs text-muted-foreground">
          {props.draft.decision === "rejected"
            ? gt("Rejected")
            : props.draft.authorization === "owner"
              ? gt("Approved by you")
              : props.draft.authorization === "self"
                ? gt("Updated by the bot")
                : gt("Activated under a grant")}
          {props.draft.activatedId && ` · ${props.draft.activatedId}`}
        </p>
      )}
      <h3 className="text-sm font-medium">
        {change.type === "schedule"
          ? gt("New schedule · {name}", { name: change.title })
          : change.type === "workflow"
            ? gt("New workflow · {name}", { name: change.title })
            : change.type === "hook"
              ? gt("New webhook · {name}", { name: change.title })
              : change.type === "bot"
                ? gt("New bot · {name}", { name: change.profile.name })
                : gt("Profile change · {name}", { name: change.profile.name })}
      </h3>
      {change.type === "schedule" ? (
        <>
          <p className="text-xs text-muted-foreground">
            {change.schedule.type === "interval"
              ? gt("Every {minutes} minutes", { minutes: change.schedule.everyMs / 60000 })
              : gt("At {time}", { time: change.schedule.timeOfDay })}
            {change.schedule.type === "fixed_time" && change.schedule.weekdays && (
              <>
                {" "}
                ·{" "}
                {change.schedule.weekdays
                  .map((day) =>
                    new Intl.DateTimeFormat(undefined, {
                      weekday: "short",
                      timeZone: "UTC",
                    }).format(new Date(Date.UTC(2024, 0, 7 + day))),
                  )
                  .join(", ")}
              </>
            )}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{change.prompt}</p>
        </>
      ) : change.type === "workflow" ? (
        <ol className="list-decimal pl-4 text-sm">
          {change.steps.map((step, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- A stored proposal's step order is immutable.
            <li key={index}>
              <strong>{step.threadId}</strong> · {step.prompt}
            </li>
          ))}
        </ol>
      ) : change.type === "hook" ? (
        <>
          <p className="whitespace-pre-wrap break-words text-sm">{change.prompt}</p>
          <p className="text-xs text-muted-foreground">
            {gt("Webhook fields")}: {change.fields.join(", ")}
          </p>
          <p className="text-xs text-muted-foreground">
            {gt("Delivery ID field")}: {change.deliveryIdField}
          </p>
        </>
      ) : (
        <>
          <p className="text-sm">
            <span style={{ color: change.profile.color }}>{change.profile.icon}</span>{" "}
            {change.profile.role}
          </p>
          <p className="text-sm text-muted-foreground">{change.profile.description}</p>
          {change.type === "profile" &&
            props.author?.instructions &&
            props.author.instructions !== change.profile.instructions && (
              <div>
                <p className="text-xs text-muted-foreground">{gt("Current instructions")}</p>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {props.author.instructions}
                </p>
              </div>
            )}
          <div>
            <p className="text-xs text-muted-foreground">{gt("Standing instructions")}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{change.profile.instructions}</p>
          </div>
        </>
      )}
      {props.draft.decision === undefined && (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("reject")}
          >
            {gt("Reject")}
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void decide("approve")}>
            {gt("Approve")}
          </Button>
        </div>
      )}
    </article>
  );
}

function BotGrants(props: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<BotProfile>;
  readonly grants: ReadonlyArray<BotGrant>;
  readonly drafts: ReadonlyArray<BotDraft>;
}) {
  const gt = useGT();
  const setGrant = useAtomCommand(serverEnvironment.setBotGrant);
  const [selected, setSelected] = useState<ThreadId | undefined>(props.bots[0]?.threadId);
  const [source, setSource] = useState<BotGrant["source"]>("direct");
  const [busy, setBusy] = useState(false);
  const bot = props.bots.find(({ threadId }) => threadId === selected);
  const sources = [
    { id: "direct", label: gt("Direct chat") },
    { id: "scheduled", label: gt("Scheduled task") },
    { id: "handoff", label: gt("Thread handoff") },
    { id: "webhook", label: gt("Webhook") },
  ] as const;
  const resources = [
    { id: "bot", label: gt("Bots") },
    { id: "schedule", label: gt("Scheduled tasks") },
    { id: "hook", label: gt("Webhooks") },
    { id: "workflow", label: gt("Workflows") },
  ] as const;
  if (props.bots.length === 0) return null;

  return (
    <section className="grid gap-2 rounded-md border p-3">
      <h3 className="text-sm font-medium">{gt("Activation grants")}</h3>
      <label className="grid gap-1 text-sm">
        {gt("Bot")}
        <select
          className="rounded-md border bg-background p-2"
          value={selected}
          onChange={(event) =>
            setSelected(
              props.bots.find(({ threadId }) => threadId === event.target.value)?.threadId,
            )
          }
        >
          {props.bots.map(({ threadId, name }) => (
            <option value={threadId} key={threadId}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        {gt("Trigger source")}
        <select
          className="rounded-md border bg-background p-2"
          value={source}
          onChange={(event) =>
            setSource(sources.find((option) => option.id === event.target.value)?.id ?? "direct")
          }
        >
          {sources.map((option) => (
            <option value={option.id} key={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {bot &&
        resources.map((resource) => {
          const allowed = props.grants.some(
            (grant) =>
              grant.threadId === bot.threadId &&
              grant.source === source &&
              grant.resource === resource.id,
          );
          return (
            <label className="flex items-center gap-2 text-sm" key={resource.id}>
              <input
                type="checkbox"
                checked={allowed}
                disabled={busy}
                onChange={async (event) => {
                  const enabled = event.target.checked;
                  if (!enabled) {
                    const resourcesById = new Map<string, BotDraft>();
                    for (const draft of props.drafts) {
                      if (
                        draft.activatedId &&
                        draft.authorThreadId === bot.threadId &&
                        !resourcesById.has(draft.activatedId)
                      ) {
                        resourcesById.set(draft.activatedId, draft);
                      }
                    }
                    const names = [...resourcesById.values()].flatMap((draft) =>
                      draft.authorization !== source || draft.change.type !== resource.id
                        ? []
                        : [
                            draft.change.type === "bot"
                              ? draft.change.profile.name
                              : draft.change.title,
                          ],
                    );
                    const message = [
                      gt("Revoke this grant and pause the resources it activated?"),
                      ...names.map((name) => `• ${name}`),
                    ].join("\n");
                    const confirmed =
                      (await requestConfirmDialog(message, { variant: "destructive" })) ??
                      window.confirm(message);
                    if (!confirmed) return;
                  }
                  setBusy(true);
                  await setGrant({
                    environmentId: props.environmentId,
                    input: { threadId: bot.threadId, resource: resource.id, source, enabled },
                  });
                  setBusy(false);
                }}
              />
              {resource.label}
            </label>
          );
        })}
    </section>
  );
}
