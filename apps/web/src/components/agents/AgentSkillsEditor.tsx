import { useState } from "react";
import { isAgentSkillStub, type AgentSkill } from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { randomUUID } from "../../lib/utils";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";

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
      <DialogPopup>
        <div className="agent-dialog p-6">
          <DialogTitle>Shared skills</DialogTitle>
          <DialogDescription className="mt-2">
            Edit a skill once, then assign it to agents. Changes sync across connected machines and
            apply to new chats. Existing chats keep their starting skills.
          </DialogDescription>
          <div className="mt-5 space-y-3 text-sm">
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
          <details className="mt-5">
            <summary className="cursor-pointer text-sm font-medium">
              Create or edit manually
            </summary>
            <form
              className="agent-form"
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
              <label>
                Skill
                <select
                  disabled={saving || loading}
                  value={selected?.skillId ?? ""}
                  onChange={(event) =>
                    void select(
                      skills.find((skill) => skill.skillId === event.target.value) ?? null,
                    )
                  }
                >
                  <option value="">New skill</option>
                  {skills.map((skill) => (
                    <option key={skill.skillId} value={skill.skillId}>
                      {skill.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Name
                <input
                  required
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                When to use
                <input
                  maxLength={1024}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label>
                SKILL.md
                <textarea
                  required
                  rows={12}
                  maxLength={64000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Paste the skill’s Markdown instructions…"
                />
              </label>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <footer>
                {selected && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() =>
                      void save(skills.filter((skill) => skill.skillId !== selected.skillId))
                    }
                  >
                    Delete skill
                  </button>
                )}
                <button
                  className="agent-primary"
                  disabled={saving || loading || !name.trim() || !content.trim()}
                >
                  {saving ? "Saving…" : "Save skill"}
                </button>
              </footer>
            </form>
          </details>
          <div className="mt-5 flex justify-end">
            <button type="button" disabled={saving} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
