import { T, useGT, useMessages } from "gt-react";
import type { SkillsLibraryStatus } from "@t3tools/contracts";
import {
  filterSkillsLibraryIssues,
  skillsLibraryIssues,
  skillsLibraryIssueSummary,
} from "@t3tools/client-runtime/skills-library-issues";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function SkillsLibraryIssuesDialog({
  status,
  environmentLabel,
  onClose,
}: {
  readonly status: SkillsLibraryStatus;
  readonly environmentLabel: string;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const issues = filterSkillsLibraryIssues(skillsLibraryIssues(status, messages), query);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Skill issues</T>
          </DialogTitle>
          <DialogDescription>
            {environmentLabel} · {skillsLibraryIssueSummary(status, messages) ?? gt("No issues")}
          </DialogDescription>
          <Input
            aria-label={gt("Search skill issues")}
            placeholder={gt("Search skills or paths")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <p className="text-xs text-muted-foreground" role="status">
            {query.trim()
              ? gt("{count, plural, one {{count} issue found} other {{count} issues found}}", {
                  count: issues.length,
                })
              : gt("{count, plural, one {{count} issue} other {{count} issues}}", {
                  count: issues.length,
                })}
          </p>
        </DialogHeader>
        <DialogPanel>
          {issues.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {query.trim()
                ? gt("No issues match. Try another skill name or path.")
                : gt("No conflicts or name mismatches.")}
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {issues.map((issue) => (
                <Collapsible
                  key={issue.key}
                  open={openKey === issue.key}
                  onOpenChange={(open) => setOpenKey(open ? issue.key : null)}
                >
                  <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left">
                    <ChevronRightIcon
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground group-data-panel-open:rotate-90"
                    />
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-medium">{issue.name}</span>
                      <span className="block break-words text-xs text-muted-foreground">
                        {issue.kind}
                      </span>
                    </span>
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    {openKey === issue.key ? (
                      <div className="space-y-2 px-4 pb-4 pl-11">
                        {issue.paths.map((path) => (
                          <p key={path} className="select-text break-all font-mono text-xs">
                            {path}
                          </p>
                        ))}
                        <p className="text-sm text-muted-foreground">{issue.guidance}</p>
                      </div>
                    ) : null}
                  </CollapsiblePanel>
                </Collapsible>
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
