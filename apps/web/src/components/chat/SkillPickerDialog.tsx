import type { SkillSummary } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { ensureLocalApi } from "../../localApi";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";

interface SkillPickerDialogProps {
  open: boolean;
  cwd: string | null;
  focusRequestId: number;
  onOpenChange: (open: boolean) => void;
  onSelectSkill: (skill: SkillSummary) => void;
}

export function formatSkillReferenceBlock(skill: SkillSummary): string {
  const description = skill.description ? `\n${skill.description.trim()}` : "";
  return [
    `## Use skill: ${skill.name}${description}`,
    "",
    `Read the full instructions from: ${skill.skillPath}`,
  ].join("\n");
}

export function SkillPickerDialog(props: SkillPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!props.open) {
      setQuery("");
      setHighlightedIndex(0);
      return;
    }
    setQuery("");
    setHighlightedIndex(0);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [props.focusRequestId, props.open]);

  const skillsQuery = useQuery({
    queryKey: ["skills", "search", props.cwd, deferredQuery],
    enabled: props.open && props.cwd !== null,
    queryFn: async () => {
      if (!props.cwd) {
        return { skills: [], truncated: false };
      }
      const api = ensureLocalApi();
      const trimmed = deferredQuery.trim();
      return api.skills.search({
        cwd: props.cwd,
        query: trimmed.length > 0 ? trimmed : "$",
        limit: 50,
      });
    },
    staleTime: 15_000,
  });

  const skills = skillsQuery.data?.skills ?? [];

  useEffect(() => {
    if (skills.length === 0) {
      setHighlightedIndex(0);
      return;
    }
    setHighlightedIndex((current) => Math.min(current, skills.length - 1));
  }, [skills.length]);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onOpenChange(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (skills.length === 0) return;
      setHighlightedIndex((current) => (current + 1) % skills.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (skills.length === 0) return;
      setHighlightedIndex((current) => (current - 1 + skills.length) % skills.length);
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const skill = skills[highlightedIndex];
    if (!skill) {
      return;
    }
    props.onSelectSkill(skill);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Search project skills and press Enter to insert a reusable skill reference into the
            composer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-2">
            <Input
              ref={inputRef}
              type="search"
              placeholder={props.cwd ? "Search skills" : "No active project"}
              data-testid="skill-picker-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              disabled={!props.cwd}
            />
            <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
              <span>
                {!props.cwd
                  ? "Open a project thread to search workspace skills."
                  : skillsQuery.isLoading
                    ? "Loading…"
                    : skillsQuery.isError
                      ? `Error: ${(skillsQuery.error as Error).message}`
                      : skills.length === 0
                        ? "No skills matched this search."
                        : `${skills.length} skill${skills.length === 1 ? "" : "s"}${
                            skillsQuery.data?.truncated ? " (truncated)" : ""
                          }`}
              </span>
              <span>Enter inserts • Up/Down moves • Esc closes</span>
            </div>
          </div>

          <div className="min-h-[24rem] overflow-hidden rounded-xl border">
            <ScrollArea>
              <div className="divide-y">
                {skills.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    {!props.cwd
                      ? "Open a thread on a project to discover its skills."
                      : "No skills matched this search."}
                  </div>
                ) : (
                  skills.map((skill, index) => {
                    const isHighlighted = index === highlightedIndex;
                    return (
                      <button
                        type="button"
                        key={skill.skillPath}
                        data-skill-picker-result="true"
                        data-highlighted={isHighlighted ? "true" : undefined}
                        className={
                          "flex w-full flex-col items-stretch gap-1 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/40 focus:bg-muted/60 focus:outline-none" +
                          (isHighlighted ? " bg-muted/60" : "")
                        }
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => props.onSelectSkill(skill)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-foreground">{skill.name}</span>
                          <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">
                            {skill.source}
                          </Badge>
                        </div>
                        {skill.description ? (
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {skill.description}
                          </span>
                        ) : null}
                        <span
                          className="truncate text-[10px] text-muted-foreground/70"
                          title={skill.skillPath}
                        >
                          {skill.skillPath}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
