import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import {
  placeTarget,
  planPlace,
  startingPlacement,
  type PlaceChoice,
  type ProjectOption,
  type Skill,
  type SkillPlan,
} from "./SkillsSettings.logic";

/** What the Use in… list needs to know about projects. */
export type PlaceOptions = {
  /** The project picked above the page; "This project only" needs one. */
  readonly picked: ProjectOption | null;
  /** This environment's registered projects. */
  readonly projects: readonly ProjectOption[];
};

const isPlaceChoice = (value: unknown): value is PlaceChoice =>
  value === "project" || value === "global" || value === "projects";

/**
 * Where skills are used: in the project picked above the page only, in every project, or in a few
 * projects. Applying hands over a plan that asks before it changes anything.
 */
export function UseInPopover({
  skills,
  places,
  busy,
  side = "bottom",
  onPlan,
}: {
  skills: readonly Skill[];
  places: PlaceOptions;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  side?: "top" | "bottom";
  onPlan: (plan: SkillPlan) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="outline" disabled={busy} />}>
        Use in…
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverPopup align="end" side={side} width="sm" padding="compact">
        {/* The form is only mounted while open, so it starts from the skills' place each time. */}
        <UseInForm
          skills={skills}
          picked={places.picked}
          projects={places.projects}
          onCancel={() => setOpen(false)}
          onApply={(plan) => {
            setOpen(false);
            onPlan(plan);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

function UseInForm({
  skills,
  picked,
  projects,
  onCancel,
  onApply,
}: {
  skills: readonly Skill[];
  picked: ProjectOption | null;
  projects: readonly ProjectOption[];
  onCancel: () => void;
  onApply: (plan: SkillPlan) => void;
}) {
  const start = useMemo(() => startingPlacement(skills, picked), [skills, picked]);
  const [choice, setChoice] = useState<PlaceChoice | null>(start.choice);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(start.ticked));
  const target = placeTarget(choice, picked, projects, ticked);
  // Nothing to apply while the skills are placed that way already.
  const plan = target ? planPlace(skills, target) : null;
  return (
    <div className="space-y-3">
      <PopoverTitle>
        {skills.length === 1 ? `Use ${skills[0]!.name}` : `Use ${skills.length} skills`}
      </PopoverTitle>
      <RadioGroup
        aria-label="Where to use it"
        value={choice ?? ""}
        onValueChange={(value) => {
          if (isPlaceChoice(value)) setChoice(value);
        }}
      >
        {picked && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Radio value="project" />
            This project only
          </label>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Radio value="global" />
          Globally
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Radio value="projects" />
          Only these projects
        </label>
      </RadioGroup>
      {choice === "projects" && (
        <ul aria-label="Projects" className="max-h-48 space-y-2 overflow-y-auto pl-6">
          {projects.map((project) => (
            <li key={project.cwd}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={ticked.has(project.cwd)}
                  onCheckedChange={(checked) =>
                    setTicked((current) => {
                      const next = new Set(current);
                      if (checked) next.add(project.cwd);
                      else next.delete(project.cwd);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 truncate">{project.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
        <Button size="xs" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={plan === null} onClick={() => plan && onApply(plan)}>
          Apply
        </Button>
      </div>
    </div>
  );
}
