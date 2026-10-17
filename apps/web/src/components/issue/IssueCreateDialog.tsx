import { useAtomValue } from "@effect/atom-react";
import { issueScopeKey } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueCreateResult,
  IssueLabel,
  IssueFieldValues,
  IssueScopeRef,
} from "@t3tools/contracts";
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
import {
  composeTemplateBody,
  initialTemplateValues,
  missingRequiredTemplateFields,
  type IssueTemplateValues,
} from "./issueCreate.logic";
import { IssueLabelPicker } from "./IssueLabelPicker";
import { IssueAssigneePicker } from "./IssueAssigneePicker";
import { issueAssigneeId } from "./issueDetail.logic";
import { IssueNativeFields, nativeFieldError, nativeFieldValues } from "./IssueNativeFields";
import { IssueTemplateForm } from "./IssueTemplateForm";
import { issueCreateBlocked, resolveIssueType } from "./IssueCreateDialog.logic";
import { reportIssueResult } from "./issueMutation";

export interface IssueCreateScope {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: string;
  readonly scope: IssueScopeRef;
  readonly templates: boolean;
  readonly labels?: boolean | undefined;
  readonly assignees?: boolean | undefined;
  readonly maxAssignees?: number | undefined;
  readonly createIssueTypes?: boolean | undefined;
  readonly createFields?: boolean | undefined;
}

const BLANK = "__blank__";

function createScopeKey(entry: IssueCreateScope) {
  return issueScopeKey(entry.environmentId, { ...entry.scope, host: entry.scope.host ?? "" });
}

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
  parent,
}: {
  open: boolean;
  parent?: { key: string; displayKey: string; noun?: string | undefined } | null;
  /** Every writable scope the page knows about; the first is preselected. */
  scopes: ReadonlyArray<IssueCreateScope>;
  onOpenChange: (open: boolean) => void;
  onCreated: (scope: IssueCreateScope, result: IssueCreateResult) => void;
}) {
  const [selectedScope, setSelectedScope] = useState(() => scopes[0] ?? null);
  if (selectedScope === null && scopes[0]) setSelectedScope(scopes[0]);
  const scopeKey = selectedScope === null ? null : createScopeKey(selectedScope);
  const scope = scopes.find((entry) => createScopeKey(entry) === scopeKey) ?? null;
  const [templateKey, setTemplateKey] = useState<string>(BLANK);
  const [templateChosen, setTemplateChosen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [bodyEdited, setBodyEdited] = useState(false);
  const [labelsEdited, setLabelsEdited] = useState(false);
  const [assigneesEdited, setAssigneesEdited] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<{
    scopeKey: string;
    key: string;
    title: boolean;
    body: boolean;
    labels: boolean;
    assignees: boolean;
  } | null>(null);
  const [values, setValues] = useState<IssueTemplateValues>({});
  const [extras, setExtras] = useState<{
    labels: ReadonlyArray<IssueLabel>;
    assignees: ReadonlyArray<string>;
  }>({
    labels: [],
    assignees: [],
  });
  const [nativeValues, setNativeValues] = useState<IssueFieldValues>({});
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
  const templateLoading = templatesQuery.isPending || (deferred && selectedQuery.isPending);
  const templateError =
    templatesQuery.error ??
    (scope?.templates && !templatesQuery.isPending && templatesQuery.data === null
      ? "Templates could not be read."
      : null) ??
    (templateKey !== BLANK &&
    !templatesQuery.isPending &&
    templatesQuery.data !== null &&
    !catalogTemplate
      ? "The selected template is no longer available. Choose a template."
      : null) ??
    (deferred && !selectedQuery.isPending
      ? (selectedQuery.error ??
        (selectedTemplate ? null : "The selected template could not be read."))
      : null);
  const templateRead =
    templatesQuery.error !== null || !catalogTemplate ? templatesQuery : selectedQuery;
  const fields = selectedTemplate?.fields ?? [];
  if (
    templateDraft &&
    templateDraft.scopeKey === scopeKey &&
    templateDraft.key === templateKey &&
    selectedTemplate &&
    !templateLoading &&
    templateError === null
  ) {
    if (templateDraft.title) setTitle(selectedTemplate.title);
    if (templateDraft.body) setBody(selectedTemplate.body);
    setValues(initialTemplateValues(selectedTemplate.fields ?? []));
    setExtras((held) => ({
      labels: templateDraft.labels
        ? selectedTemplate.labels.map((name) => ({ name, color: null }))
        : held.labels,
      assignees: templateDraft.assignees ? selectedTemplate.assignees : held.assignees,
    }));
    setTemplateDraft(null);
  }
  const blankAllowed = templatesQuery.data?.blankIssuesEnabled ?? true;
  const candidatesQuery = useEnvironmentQuery(
    open && scope !== null && (scope.createIssueTypes === true || scope.createFields === true)
      ? issueEnvironment.candidates({
          environmentId: scope.environmentId,
          input: { ...scope.scope, ...(issueType === null ? {} : { issueType }) },
        })
      : null,
  );
  const issueTypes = candidatesQuery.data?.issueTypes ?? [];
  const chosenIssueType = resolveIssueType(issueTypes, issueType);

  const nativeFields = candidatesQuery.data?.fields ?? [];
  const nativeForm = scope?.createFields === true || nativeFields.length > 0;
  if (nativeForm && issueType === null && chosenIssueType !== null) setIssueType(chosenIssueType);

  const reset = () => {
    setNativeValues({});
    setTemplateKey(BLANK);
    setTemplateChosen(false);
    setTemplateDraft(null);
    setTitle("");
    setBody("");
    setTitleEdited(false);
    setBodyEdited(false);
    setLabelsEdited(false);
    setAssigneesEdited(false);
    setExtras({ labels: [], assignees: [] });
    setIssueType(null);
    setValues({});
  };

  const chooseTemplate = (key: string | null, automatic = false) => {
    if (key === null) return;
    setTemplateKey(key);
    setTemplateChosen(true);
    const template = templates.find((entry) => entry.key === key);
    setValues({});
    const recoveringBlank = key === BLANK && templateKey !== BLANK && !catalogTemplate;
    if (!automatic && !recoveringBlank) {
      setExtras({ labels: [], assignees: [] });
      setLabelsEdited(false);
      setAssigneesEdited(false);
    }
    setTemplateDraft(
      template && scope
        ? {
            scopeKey: createScopeKey(scope),
            key,
            title: !titleEdited,
            body: !bodyEdited,
            labels: !automatic || !labelsEdited,
            assignees: !automatic || !assigneesEdited,
          }
        : null,
    );
  };

  if (
    open &&
    scope?.templates &&
    !templateChosen &&
    !templatesQuery.isPending &&
    templatesQuery.error === null &&
    templates[0]
  ) {
    chooseTemplate(templates[0].key, true);
  }

  const missing = missingRequiredTemplateFields(fields, values);
  const blocked =
    (scope === null && scopes.length > 0 ? "Choose a project to file this issue." : null) ??
    issueCreateBlocked({
      hasScope: scope !== null,
      canWrite,
      templates: scope?.templates
        ? {
            pending: templatesQuery.isPending,
            error: templatesQuery.error,
            list: templatesQuery.data,
          }
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
    (nativeForm
      ? (candidatesQuery.error ??
        (candidatesQuery.isPending || candidatesQuery.data === null
          ? "Loading fields…"
          : nativeFieldError(nativeFields, nativeValues)))
      : null) ??
    templateError ??
    (scope?.templates && (templateLoading || templateDraft !== null)
      ? "Loading template…"
      : null) ??
    (missing.length > 0 ? `Fill in ${missing.join(", ")}.` : null);

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
        body:
          fields.length > 0
            ? [bodyEdited ? body : "", composeTemplateBody(fields, values)]
                .filter(Boolean)
                .join("\n\n")
            : body,
        ...(selectedTemplate ? { templateKey: selectedTemplate.key } : {}),
        ...(parent ? { parentKey: parent.key } : {}),
        labels: extras.labels.map((label) => label.id ?? label.name),
        assignees: extras.assignees,
        ...(chosenIssueType === null ? {} : { issueType: chosenIssueType }),
        ...(nativeForm ? { fieldValues: nativeFieldValues(nativeFields, nativeValues) } : {}),
      },
    });
    setPending(false);
    if (!reportIssueResult(result, "The issue could not be created", "The tracker refused it."))
      return;
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
          <DialogTitle>
            {parent
              ? `New ${parent.noun?.toLowerCase().replace(/s$/, "") ?? "sub-issue"} of ${parent.displayKey}`
              : "New issue"}
          </DialogTitle>
          <DialogDescription>File an issue on the project's tracker.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap gap-3">
            {scopes.length > 1 || (scopes.length > 0 && scope === null) ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-scope">Project</Label>
                <Select
                  value={scope === null ? null : scopeKey}
                  onValueChange={(value) => {
                    if (value === null) return;
                    const next = scopes.find((entry) => createScopeKey(entry) === value);
                    if (!next) return;
                    if (
                      next.scope.connectionId !== selectedScope?.scope.connectionId ||
                      (next.scope.connectionId !== undefined &&
                        next.environmentId !== selectedScope?.environmentId)
                    )
                      reset();
                    setSelectedScope(next);
                    setTemplateKey(BLANK);
                    setTemplateChosen(false);
                    setTemplateDraft(null);
                    setExtras({ labels: [], assignees: [] });
                    setLabelsEdited(false);
                    setAssigneesEdited(false);
                    setIssueType(null);
                    setNativeValues({});
                  }}
                >
                  <SelectTrigger id="issue-create-scope" size="sm" aria-label="Project">
                    <SelectValue>
                      {scope
                        ? `${scope.projectTitle} · ${scope.scope.scope}${scope.scope.connectionId === undefined ? "" : ` · ${scope.scope.connectionId}`}`
                        : "Choose a project"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {scopes.map((entry) => (
                      <SelectItem key={createScopeKey(entry)} value={createScopeKey(entry)}>
                        {entry.projectTitle} · {entry.scope.scope}
                        {entry.scope.connectionId === undefined
                          ? ""
                          : ` · ${entry.scope.connectionId}`}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {scope?.templates &&
            (templates.length > 0 ||
              templatesQuery.isPending ||
              (blankAllowed && templateKey !== BLANK && !catalogTemplate)) ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-template">Template</Label>
                <Select
                  value={templateKey}
                  onValueChange={(key, details) => {
                    if (details.reason === "none" && templateKey !== BLANK && !catalogTemplate) {
                      details.cancel();
                      return;
                    }
                    chooseTemplate(key);
                  }}
                  disabled={templatesQuery.isPending}
                >
                  <SelectTrigger id="issue-create-template" size="sm" aria-label="Template">
                    <SelectValue>
                      {templatesQuery.isPending
                        ? "Loading templates…"
                        : (templates.find((t) => t.key === templateKey)?.name ??
                          (templateKey === BLANK ? "Blank issue" : "Choose a template"))}
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
                  onValueChange={(value) => {
                    setIssueType(value || null);
                    setNativeValues({});
                  }}
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
          {(templatesQuery.data?.contactLinks?.length ?? 0) > 0 ? (
            <p className="flex flex-wrap gap-3 text-xs">
              {templatesQuery.data?.contactLinks?.map((link) => (
                <InlineButton
                  key={link.url}
                  title={link.about}
                  render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
                >
                  {link.name}
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </InlineButton>
              ))}
            </p>
          ) : null}
          {templatesQuery.data?.contributingGuidelinesUrl ? (
            <InlineButton
              render={
                <a
                  href={templatesQuery.data.contributingGuidelinesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              Contributing guidelines
              <ExternalLinkIcon aria-hidden className="size-3" />
            </InlineButton>
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
                setTemplateDraft((held) => (held ? { ...held, title: false } : null));
                setTitle(event.target.value);
              }}
              placeholder="A short summary"
            />
          </div>
          {fields.length > 0 ? (
            <IssueTemplateForm fields={fields} values={values} onChange={setValues} />
          ) : null}
          {fields.length === 0 || bodyEdited ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-create-body">Description</Label>
              <Textarea
                id="issue-create-body"
                size="lg"
                value={body}
                disabled={pending}
                onChange={(event) => {
                  setBodyEdited(true);
                  setTemplateDraft((held) => (held ? { ...held, body: false } : null));
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
          ) : null}
          {nativeForm ? (
            <IssueNativeFields
              fields={nativeFields}
              values={nativeValues}
              onChange={setNativeValues}
              disabled={pending}
            />
          ) : null}
          {scope?.createFields === true && candidatesQuery.error !== null ? (
            <Button size="xs" variant="outline" onClick={candidatesQuery.refresh}>
              Retry fields
            </Button>
          ) : null}
          {scope ? (
            <div className="flex flex-wrap items-center gap-2">
              {scope.labels ? (
                <IssueLabelPicker
                  environmentId={scope.environmentId}
                  source={scope.scope}
                  selected={extras.labels}
                  allowed={canWrite}
                  disabled={pending}
                  onChange={(next) => {
                    setLabelsEdited(true);
                    setTemplateDraft((held) => (held ? { ...held, labels: false } : null));
                    setExtras((held) => ({ ...held, labels: next }));
                  }}
                />
              ) : null}
              {scope.assignees ? (
                <IssueAssigneePicker
                  environmentId={scope.environmentId}
                  source={scope.scope}
                  selected={extras.assignees.map((id) => ({
                    id,
                    login: id,
                    name: null,
                    avatarUrl: null,
                  }))}
                  max={scope.maxAssignees ?? 100}
                  allowed={canWrite}
                  disabled={pending}
                  onChange={(next) => {
                    setAssigneesEdited(true);
                    setTemplateDraft((held) => (held ? { ...held, assignees: false } : null));
                    setExtras((held) => ({ ...held, assignees: next.map(issueAssigneeId) }));
                  }}
                />
              ) : null}
            </div>
          ) : null}
          {extras.labels.length > 0 || extras.assignees.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {extras.labels.length > 0
                ? `Labels: ${extras.labels.map((label) => label.name).join(", ")}`
                : null}
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
              disabled={templateRead.isPending}
              onClick={templateRead.refresh}
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
            {pending
              ? "Creating…"
              : parent?.noun
                ? `Create ${parent.noun.toLowerCase().replace(/s$/, "")}`
                : "Create issue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
