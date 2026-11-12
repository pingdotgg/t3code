import { useState } from "react";
import {
  AGENT_MAX_TAG_LENGTH,
  AGENT_MAX_TAGS,
  agentTagOptions,
  normalizeAgentTags,
} from "@t3tools/client-runtime/state/agentIdentity";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { CheckIcon } from "lucide-react";
import { Toggle } from "../ui/toggle";

/** Role tags: toggle the suggested roles or type your own. */
export function AgentTagsField({
  tags,
  onChange,
}: {
  tags: ReadonlyArray<string>;
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const selected = new Set(tags.map((tag) => tag.toLocaleLowerCase()));
  const full = tags.length >= AGENT_MAX_TAGS;
  const add = () => {
    if (!draft.trim()) return;
    onChange(normalizeAgentTags([...tags, draft]));
    setDraft("");
  };
  return (
    <fieldset>
      <Label render={<legend />} className="mb-1.5">
        Role <span className="font-normal text-muted-foreground">optional, pick any</span>
      </Label>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Roles">
        {agentTagOptions(tags).map((tag) => {
          const pressed = selected.has(tag.toLocaleLowerCase());
          return (
            <Toggle
              key={tag}
              variant="outline"
              size="sm"
              pressed={pressed}
              disabled={!pressed && full}
              onPressedChange={() =>
                onChange(
                  pressed
                    ? tags.filter((item) => item.toLocaleLowerCase() !== tag.toLocaleLowerCase())
                    : normalizeAgentTags([...tags, tag]),
                )
              }
            >
              {pressed && <CheckIcon />}
              {tag}
            </Toggle>
          );
        })}
        <Input
          size="compact"
          className="w-32 grow"
          aria-label="Add a custom role"
          placeholder={full ? `Up to ${AGENT_MAX_TAGS} roles` : "Add role…"}
          maxLength={AGENT_MAX_TAG_LENGTH}
          disabled={full}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== ",") return;
            event.preventDefault();
            add();
          }}
        />
      </div>
    </fieldset>
  );
}
