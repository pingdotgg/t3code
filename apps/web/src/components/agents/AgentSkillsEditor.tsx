import { useId, useState } from "react";
import { isAgentSkillStub, type AgentSkill } from "@t3tools/contracts";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { randomUUID } from "../../lib/utils";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";

const NEW_SKILL = "";

export function AgentSkillsEditor({
  skills,
  onSave,
  onClose,
}: {
  skills: ReadonlyArray<AgentSkill>;
  onSave: (skills: ReadonlyArray<AgentSkill>) => Promise<boolean | undefined>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<AgentSkill | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { loadSkills } = useAgentLibrary();
  const ids = useId();
  const fill = (skill: AgentSkill | null) => {
    setSelected(skill);
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setContent(skill?.content ?? "");
    setError("");
  };
  const select = async (skill: AgentSkill | null) => {
    if (!skill || !isAgentSkillStub(skill)) return fill(skill);
    fill(null);
    setLoading(true);
    const [full] = await loadSkills([skill.skillId]).catch(() => []);
    setLoading(false);
    if (full) fill(full);
    else setError("Could not load this skill. Connect the machine that holds it and try again.");
  };
  const save = async (next: ReadonlyArray<AgentSkill>) => {
    setSaving(true);
    setError("");
    try {
      if (await onSave(next)) fill(null);
      else setError("Could not save skills. Check your connection and try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save skills.");
    }
    setSaving(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Shared skills</DialogTitle>
          <DialogDescription>
            Edit a skill once, then assign it to agents. Changes sync across connected machines and
            apply to new chats. Existing chats keep their starting skills.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-sm">
            <p>
              Ask an agent to create or update skills using the T3 Agents MCP. It can save skills to
              this shared library and assign them to the agents you choose.
            </p>
            <p className="rounded-lg bg-muted p-3 text-muted-foreground">
              Try: “Create a shared skill for reviewing pull requests and assign it to Randy.”
            </p>
            <p className="text-muted-foreground">
              {skills.length} shared {skills.length === 1 ? "skill" : "skills"} in your library.
              Enable the T3 Agents MCP in your agent’s harness to get started.
            </p>
          </div>
          <details className="border-t pt-4">
            <summary className="cursor-pointer text-sm font-medium">
              Create or edit manually
            </summary>
            <form
              className="mt-4 flex flex-col gap-4"
              onSubmit={async (event) => {
                event.preventDefault();
                const now = new Date().toISOString();
                const skill: AgentSkill = {
                  ...selected,
                  skillId: selected?.skillId ?? randomUUID(),
                  name: name.trim(),
                  description: description.trim(),
                  content,
                  revision: selected?.revision ?? 1,
                  createdAt: selected?.createdAt ?? now,
                  updatedAt: now,
                };
                await save(
                  selected
                    ? skills.map((item) => (item.skillId === selected.skillId ? skill : item))
                    : [...skills, skill],
                );
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-skill`}>Skill</Label>
                <Select
                  items={{
                    [NEW_SKILL]: "New skill",
                    ...Object.fromEntries(skills.map((skill) => [skill.skillId, skill.name])),
                  }}
                  disabled={saving || loading}
                  value={selected?.skillId ?? NEW_SKILL}
                  onValueChange={(value) =>
                    void select(skills.find((skill) => skill.skillId === value) ?? null)
                  }
                >
                  <SelectTrigger id={`${ids}-skill`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NEW_SKILL}>New skill</SelectItem>
                    {skills.map((skill) => (
                      <SelectItem key={skill.skillId} value={skill.skillId}>
                        {skill.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-name`}>Name</Label>
                <Input
                  id={`${ids}-name`}
                  required
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-when`}>When to use</Label>
                <Input
                  id={`${ids}-when`}
                  maxLength={1024}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-content`}>SKILL.md</Label>
                <Textarea
                  id={`${ids}-content`}
                  required
                  rows={12}
                  maxLength={64000}
                  className="max-h-96"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Paste the skill’s Markdown instructions…"
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                {selected && (
                  <Button
                    type="button"
                    variant="destructive-outline"
                    disabled={saving}
                    onClick={() =>
                      void save(skills.filter((skill) => skill.skillId !== selected.skillId))
                    }
                  >
                    Delete skill
                  </Button>
                )}
                <Button
                  type="submit"
                  disabled={saving || loading || !name.trim() || !content.trim()}
                >
                  {saving ? "Saving…" : "Save skill"}
                </Button>
              </div>
            </form>
          </details>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
