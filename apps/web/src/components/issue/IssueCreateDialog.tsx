import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueCreateResult, IssueScopeRef } from "@t3tools/contracts";
import { useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";

export interface IssueCreateScope {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: string;
  readonly scope: IssueScopeRef;
  readonly templates: boolean;
}

const BLANK = "__blank__";

/**
 * One text box with a draft in it, on any tracker: a chosen template fills the title, body,
 * labels and assignees, and the writer takes it from there. Templates are read when the dialog
 * opens, for the scope it opens on.
 */
export function IssueCreateDialog({
  open,
  scopes,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  /** Every writable scope the page knows about; the first is preselected. */
  scopes: ReadonlyArray<IssueCreateScope>;
  onOpenChange: (open: boolean) => void;
  onCreated: (scope: IssueCreateScope, result: IssueCreateResult) => void;
}) {
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)] ?? null;
  const [templateKey, setTemplateKey] = useState<string>(BLANK);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [extras, setExtras] = useState<{
    labels: ReadonlyArray<string>;
    assignees: ReadonlyArray<string>;
  }>({
    labels: [],
    assignees: [],
  });
  const [pending, setPending] = useState(false);
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const canWrite = useAtomValue(
    issueEnvironment.create.permissionAtom(scope?.environmentId ?? null),
  );
  const templatesQuery = useEnvironmentQuery(
    open && scope !== null && scope.templates
      ? issueEnvironment.templates({ environmentId: scope.environmentId, input: scope.scope })
      : null,
  );
  const templates = templatesQuery.data?.templates ?? [];
  const blankAllowed = templatesQuery.data?.blankIssuesEnabled ?? true;

  const reset = () => {
    setTemplateKey(BLANK);
    setTitle("");
    setBody("");
    setExtras({ labels: [], assignees: [] });
  };

  const chooseTemplate = (key: string | null) => {
    const next = key ?? BLANK;
    setTemplateKey(next);
    const template = templates.find((entry) => entry.key === next);
    if (!template) {
      setExtras({ labels: [], assignees: [] });
      return;
    }
    // A template is a starting point: it only overwrites what the writer has not typed yet.
    if (title.trim().length === 0) setTitle(template.title);
    if (body.trim().length === 0) setBody(template.body);
    setExtras({ labels: template.labels, assignees: template.assignees });
  };

  const submit = async () => {
    if (scope === null || pending) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) return;
    setPending(true);
    const result = await create({
      environmentId: scope.environmentId,
      input: {
        ...scope.scope,
        title: trimmedTitle,
        body,
        labels: extras.labels,
        assignees: extras.assignees,
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The issue could not be created",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    toastManager.add({ type: "success", title: `Created ${result.value.displayKey}` });
    reset();
    onCreated(scope, result.value);
    onOpenChange(false);
  };

  const blocked =
    scope === null
      ? "No project here can file issues."
      : !canWrite
        ? "Creating issues needs the source-control write scope."
        : !blankAllowed && templateKey === BLANK && templates.length > 0
          ? "This tracker requires a template."
          : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>File an issue on the project's tracker.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap gap-3">
            {scopes.length > 1 ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-scope">Project</Label>
                <Select
                  value={String(scopeIndex)}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setScopeIndex(Number(value));
                    setTemplateKey(BLANK);
                    setExtras({ labels: [], assignees: [] });
                  }}
                >
                  <SelectTrigger id="issue-create-scope" size="sm" aria-label="Project">
                    <SelectValue>
                      {scope ? `${scope.projectTitle} · ${scope.scope.scope}` : ""}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {scopes.map((entry, index) => (
                      <SelectItem
                        key={`${entry.environmentId}:${entry.scope.projectId}`}
                        value={String(index)}
                      >
                        {entry.projectTitle} · {entry.scope.scope}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {scope?.templates && (templates.length > 0 || templatesQuery.isPending) ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-template">Template</Label>
                <Select
                  value={templateKey}
                  onValueChange={chooseTemplate}
                  disabled={templatesQuery.isPending}
                >
                  <SelectTrigger id="issue-create-template" size="sm" aria-label="Template">
                    <SelectValue>
                      {templatesQuery.isPending
                        ? "Loading templates…"
                        : (templates.find((t) => t.key === templateKey)?.name ?? "Blank issue")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {blankAllowed ? <SelectItem value={BLANK}>Blank issue</SelectItem> : null}
                    {templates.map((template) => (
                      <SelectItem key={template.key} value={template.key}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{template.name}</span>
                          {template.about ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {template.about}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="issue-create-title">Title</Label>
            <Input
              id="issue-create-title"
              autoFocus
              value={title}
              disabled={pending}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="A short summary"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="issue-create-body">Description</Label>
            <Textarea
              id="issue-create-body"
              size="lg"
              value={body}
              disabled={pending}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Markdown is supported"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          {extras.labels.length > 0 || extras.assignees.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {extras.labels.length > 0 ? `Labels: ${extras.labels.join(", ")}` : null}
              {extras.labels.length > 0 && extras.assignees.length > 0 ? " · " : null}
              {extras.assignees.length > 0 ? `Assignees: ${extras.assignees.join(", ")}` : null}
            </p>
          ) : null}
          {blocked ? <p className="text-xs text-muted-foreground">{blocked}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending || blocked !== null || title.trim().length === 0}
            onClick={() => void submit()}
          >
            {pending ? "Creating…" : "Create issue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
