import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueCreateResult, IssueScopeRef } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button, InlineButton } from "../ui/button";
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
import { issueCreateBlocked, resolveIssueType } from "./IssueCreateDialog.logic";

export interface IssueCreateScope {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: string;
  readonly scope: IssueScopeRef;
  readonly templates: boolean;
  readonly createIssueTypes?: boolean;
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
  const [chosenScope, setChosenScope] = useState<IssueCreateScope | null>(null);
  if (chosenScope === null && scopes[0] !== undefined) setChosenScope(scopes[0]);
  const scopeIndex = scopes.findIndex(
    (entry) =>
      entry.environmentId === chosenScope?.environmentId &&
      entry.scope.projectId === chosenScope.scope.projectId &&
      entry.scope.tracker === chosenScope.scope.tracker &&
      entry.scope.host === chosenScope.scope.host &&
      entry.scope.scope === chosenScope.scope.scope,
  );
  const scope = scopes[scopeIndex] ?? null;
  const [templateKey, setTemplateKey] = useState<string>(BLANK);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [bodyEdited, setBodyEdited] = useState(false);
  const [draft, setDraft] = useState<{ title: boolean; body: boolean } | null>(null);
  const [extras, setExtras] = useState<{
    labels: ReadonlyArray<string>;
    assignees: ReadonlyArray<string>;
  }>({
    labels: [],
    assignees: [],
  });
  const [issueType, setIssueType] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const canWrite = useAtomValue(
    issueEnvironment.create.permissionAtom(scope?.environmentId ?? null),
  );
  const templatesQuery = useEnvironmentQuery(
    open && scope !== null && scope.templates
      ? issueEnvironment.templates({
          environmentId: scope.environmentId,
          input: { ...scope.scope, metadataOnly: true },
        })
      : null,
  );
  const templates = templatesQuery.data?.templates ?? [];
  const externalTemplates = templatesQuery.data?.externalTemplates ?? [];
  const catalogTemplate = templates.find((template) => template.key === templateKey);
  const deferred = catalogTemplate?.contentDeferred === true;
  const selectedQuery = useEnvironmentQuery(
    open && scope !== null && deferred
      ? issueEnvironment.templates({
          environmentId: scope.environmentId,
          input: { ...scope.scope, templateKey },
        })
      : null,
  );
  const selectedTemplate = deferred
    ? selectedQuery.data?.templates.find(
        (template) => template.key === templateKey && template.contentDeferred !== true,
      )
    : catalogTemplate;
  if (draft !== null && selectedTemplate !== undefined) {
    if (draft.title) setTitle(selectedTemplate.title);
    if (draft.body) setBody(selectedTemplate.body);
    setExtras({ labels: selectedTemplate.labels, assignees: selectedTemplate.assignees });
    setDraft(null);
  }
  const selectedRead = deferred && selectedTemplate === undefined ? selectedQuery : null;
  const templateError =
    templatesQuery.data === null && templatesQuery.error !== null
      ? `Templates could not be read: ${templatesQuery.error}`
      : templateKey !== BLANK && templatesQuery.data !== null && catalogTemplate === undefined
        ? "The chosen template is no longer offered."
        : selectedRead?.error
          ? `The template could not be read: ${selectedRead.error}`
          : selectedRead?.isSuccess && !selectedRead.isPending
            ? "The template could not be read."
            : null;
  const blankAllowed = templatesQuery.data?.blankIssuesEnabled ?? true;
  const candidatesQuery = useEnvironmentQuery(
    open && scope !== null && scope.createIssueTypes === true
      ? issueEnvironment.candidates({ environmentId: scope.environmentId, input: scope.scope })
      : null,
  );
  const issueTypes = candidatesQuery.data?.issueTypes ?? [];
  const chosenIssueType = resolveIssueType(issueTypes, issueType);

  const reset = () => {
    setTemplateKey(BLANK);
    setDraft(null);
    setTitle("");
    setBody("");
    setTitleEdited(false);
    setBodyEdited(false);
    setExtras({ labels: [], assignees: [] });
    setIssueType(null);
  };

  const chooseTemplate = (key: string | null) => {
    const next = key ?? BLANK;
    setTemplateKey(next);
    setExtras({ labels: [], assignees: [] });
    // A template is a starting point: it only overwrites what the writer has not typed yet.
    setDraft(
      templates.some((entry) => entry.key === next)
        ? { title: !titleEdited, body: !bodyEdited }
        : null,
    );
  };

  const blocked =
    scope === null && scopes.length > 0
      ? "Choose a project."
      : (issueCreateBlocked({
          hasScope: scope !== null,
          canWrite,
          templates: scope?.templates
            ? { pending: templatesQuery.isPending, list: templatesQuery.data }
            : null,
          blankChosen: templateKey === BLANK,
          issueTypes:
            scope?.createIssueTypes === true
              ? {
                  pending: candidatesQuery.isPending,
                  error: candidatesQuery.error,
                  count: issueTypes.length,
                  chosen: chosenIssueType,
                }
              : null,
        }) ??
        templateError ??
        (selectedRead ? "Loading template…" : null));

  const submit = async () => {
    if (scope === null || pending || blocked !== null) return;
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
        ...(chosenIssueType === null ? {} : { issueType: chosenIssueType }),
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
    const warnings = result.value.warnings ?? [];
    toastManager.add(
      warnings.length === 0
        ? { type: "success", title: `Created ${result.value.displayKey}` }
        : {
            type: "warning",
            title: `Created ${result.value.displayKey} with warnings`,
            description: warnings.join(" "),
          },
    );
    reset();
    onCreated(scope, result.value);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>File an issue on the project's tracker.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap gap-3">
            {scopes.length > (scope === null ? 0 : 1) ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-scope">Project</Label>
                <Select
                  value={scope === null ? null : String(scopeIndex)}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setChosenScope(scopes[Number(value)] ?? null);
                    setTemplateKey(BLANK);
                    setDraft(null);
                    setExtras({ labels: [], assignees: [] });
                    setIssueType(null);
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
                        key={`${entry.environmentId}:${entry.scope.projectId}:${entry.scope.tracker}:${entry.scope.host ?? ""}:${entry.scope.scope}`}
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
            {scope?.createIssueTypes === true && issueTypes.length > 1 ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-type">Issue type</Label>
                <Select
                  value={chosenIssueType ?? ""}
                  onValueChange={(value) => setIssueType(value || null)}
                >
                  <SelectTrigger id="issue-create-type" size="sm" aria-label="Issue type">
                    <SelectValue>
                      {issueTypes.find((type) => type.id === chosenIssueType)?.name ??
                        "Choose a type"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {issueTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
          </div>
          {externalTemplates.length > 0 ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              Fill in on the tracker:
              {externalTemplates.map((template) => (
                <InlineButton
                  key={template.url}
                  title={template.about || undefined}
                  render={<a href={template.url} target="_blank" rel="noreferrer noopener" />}
                >
                  {template.name}
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </InlineButton>
              ))}
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="issue-create-title">Title</Label>
            <Input
              id="issue-create-title"
              autoFocus
              value={title}
              disabled={pending}
              onChange={(event) => {
                setTitleEdited(true);
                setDraft((held) => (held ? { ...held, title: false } : null));
                setTitle(event.target.value);
              }}
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
              onChange={(event) => {
                setBodyEdited(true);
                setDraft((held) => (held ? { ...held, body: false } : null));
                setBody(event.target.value);
              }}
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
          {templateError !== null ? (
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              disabled={(selectedRead ?? templatesQuery).isPending}
              onClick={(selectedRead ?? templatesQuery).refresh}
            >
              Retry
            </Button>
          ) : null}
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
