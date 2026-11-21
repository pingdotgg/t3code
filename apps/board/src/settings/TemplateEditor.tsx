import { type FormEvent, useState } from "react";

import { EVERY_TICKET, type ReviewTemplate } from "../domain/reviewTemplate";
import { buttonClass } from "./controls/buttonClass";
import { fieldClass } from "./controls/fieldClass";
import { Select } from "./controls/Select";

type Mark = "none" | "check" | "lane";

const MARKS = [
  { value: "none", title: "Not used" },
  { value: "check", title: "Author check" },
  { value: "lane", title: "Reviewer lane" },
] as const;

const marksOf = (template: ReviewTemplate) =>
  new Map<string, Mark>([
    ...template.lanes.map((lane): [string, Mark] => [lane.skill, "lane"]),
    ...template.authorChecks.map((skill): [string, Mark] => [skill, "check"]),
  ]);

/** A name and the skills of the board's Claude instance, each marked as an author check or a reviewer lane. A copied template starts with its own marks. */
export function TemplateEditor({
  start,
  taken,
  skills,
  onSave,
  onCancel,
}: {
  start: ReviewTemplate | null;
  taken: ReadonlyArray<string>;
  skills: ReadonlyArray<string>;
  onSave: (template: ReviewTemplate) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(start === null ? "" : `Copy of ${start.name}`);
  const [marks, setMarks] = useState(start === null ? new Map<string, Mark>() : marksOf(start));
  const [error, setError] = useState<string | null>(null);
  const rows = [...new Set([...skills, ...marks.keys()])];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const picked = (mark: Mark) => rows.filter((skill) => marks.get(skill) === mark);
    if (trimmed === "") setError("Name the template.");
    else if (taken.includes(trimmed)) setError(`A template named ${trimmed} already exists.`);
    else if (picked("check").length + picked("lane").length === 0) setError("Pick a skill.");
    else {
      onSave({
        name: trimmed,
        authorChecks: picked("check"),
        lanes: picked("lane").map((skill) => ({ skill, runsWhen: EVERY_TICKET })),
      });
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 px-3 py-2.5">
      <input
        aria-label="Template name"
        value={name}
        placeholder="Template name"
        onChange={(event) => setName(event.target.value)}
        className={`${fieldClass} w-72`}
      />
      <ul aria-label="Skills" className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {rows.map((skill) => (
          <li key={skill} className="flex items-center justify-between gap-4">
            <span className="min-w-0 truncate font-mono text-[12px]">{skill}</span>
            <Select
              label={`Use of ${skill}`}
              value={marks.get(skill) ?? "none"}
              options={MARKS}
              onChange={(mark) => setMarks(new Map(marks).set(skill, mark))}
            />
          </li>
        ))}
      </ul>
      {error !== null && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={buttonClass}>
          Save template
        </button>
        <button type="button" onClick={onCancel} className={buttonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}
