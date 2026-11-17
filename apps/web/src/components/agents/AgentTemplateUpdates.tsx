import { useState } from "react";
import { BookOpenIcon } from "lucide-react";
import {
  agentTemplateMergePrompt,
  applyAgentTemplateUpdate,
  type AgentTemplateUpdate,
} from "@t3tools/shared/agentTemplateUpdates";
import { APP_NAME } from "@t3tools/shared/branding";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import { randomUUID } from "../../lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { AgentIcon } from "./AgentIcon";
import type { AgentTaskSeed } from "./AgentTaskDialog";

const templateDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const updateKey = (update: AgentTemplateUpdate) =>
  update.kind === "agent" ? `agent:${update.profile.profileId}` : `skill:${update.skill.skillId}`;

export function AgentTemplateUpdates({
  updates,
  onMerge,
  onClose,
}: {
  updates: ReadonlyArray<AgentTemplateUpdate>;
  onMerge: (update: AgentTemplateUpdate, seed: AgentTaskSeed) => void;
  onClose: () => void;
}) {
  const { profiles, skills, skillResourcesAvailable, loadSkills, updateSettings } =
    useAgentLibrary();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const library = { agentSkills: skills, mcpGatewayProfiles: profiles };
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      if ((await action()) === false)
        setError("Could not save the update. Check your connection and try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the update.");
    }
    setBusy(null);
  };
  const update = (item: AgentTemplateUpdate) =>
    run(updateKey(item), () => {
      const templateSkills = item.kind === "skill" ? [item.template] : item.template.skills;
      if (templateSkills.some((skill) => skill.resources.length) && !skillResourcesAvailable)
        throw new Error(`Update ${APP_NAME} on this machine to add this template’s skill files.`);
      return updateSettings(
        applyAgentTemplateUpdate(library, item, {
          now: new Date().toISOString(),
          makeId: randomUUID,
        }),
      );
    });
  const merge = (item: AgentTemplateUpdate) =>
    run(updateKey(item), async () => {
      const [full] =
        item.kind === "skill" ? await loadSkills([item.skill.skillId]).catch(() => []) : [];
      onMerge(item, {
        draftKey: `agent-template-merge:${updateKey(item)}`,
        prompt: agentTemplateMergePrompt(item, library, full),
      });
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busy === null) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Template updates</DialogTitle>
          <DialogDescription>
            {APP_NAME} updated the templates of built-in agents and skills you installed. Copies you
            edited are never replaced: an agent chat merges the update into your copy for you to
            review.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error && (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {updates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Everything is up to date.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {updates.map((item) => {
                const key = updateKey(item);
                const name = item.kind === "agent" ? item.profile.name : item.skill.name;
                return (
                  <li
                    key={key}
                    className="flex min-w-0 items-center gap-3 rounded-lg border bg-background px-3 py-2.5"
                  >
                    {item.kind === "agent" ? (
                      <AgentIcon icon={item.profile.icon} iconId={item.profile.iconId} />
                    ) : (
                      <BookOpenIcon className="size-5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <strong className="truncate text-sm font-medium">
                        {name}
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · {item.kind === "agent" ? "Agent" : "Skill"}
                        </span>
                      </strong>
                      <span className="text-xs text-muted-foreground">
                        Template updated in {APP_NAME} on{" "}
                        {templateDate.format(Date.parse(item.template.template.updatedAt))}.
                        {item.modified && " Your copy has your own changes."}
                      </span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant={item.modified ? "outline" : "default"}
                      disabled={busy !== null}
                      onClick={() => void (item.modified ? merge(item) : update(item))}
                    >
                      {busy === key ? "Working…" : item.modified ? "Merge with an agent" : "Update"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy !== null} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
