import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  buildIssueTemplateBody,
  issueTemplateAnswerOptions,
  issueTemplateAnswersComplete,
  issueTemplateAnswerText,
  type EnvironmentId,
  type IssueTemplate,
  type IssueTemplateAnswers,
  type IssueTemplateField,
  type IssueTemplateFieldAnswer,
  type IssueTemplateQuestion,
  type ProjectId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  Maximize2Icon,
  Minimize2Icon,
  PlusIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { isMacPlatform } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { readableFailure } from "../sourceControl/handoff";
import { HostMarkdown } from "../sourceControl/HostMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A list written by hand, since a new issue has no reference for the candidate reads a picker
 * would use. Split on commas rather than on whitespace: a GitHub label is `good first issue`,
 * spaces and all.
 */
function parseList(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The repository an issue would be filed against, as the host spells it, or null where this
 * project has no host to file one on. A project checked out from nothing in particular is not a
 * place issues live, so it is left out of the picker rather than offered and refused.
 */
function repositoryOf(identity: {
  readonly displayName?: string | undefined;
  readonly owner?: string | undefined;
  readonly name?: string | undefined;
}): string | null {
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

/**
 * Which of the repository's starting points this issue is being written from. Null until one has
 * been taken, which is the chooser step; `blank` is the empty form the chooser offers last.
 */
type Choice = { readonly kind: "blank" } | { readonly kind: "template"; readonly key: string };

/** What a form's controls start at: whatever the template prefilled, and nothing taken. */
function initialAnswers(fields: ReadonlyArray<IssueTemplateField>): IssueTemplateAnswers {
  const answers: Record<string, IssueTemplateFieldAnswer> = {};
  for (const field of fields) {
    if (field.kind === "markdown") continue;
    answers[field.id] = field.kind === "input" || field.kind === "textarea" ? field.value : [];
  }
  return answers;
}

/** What the host marks a question it will not file without, in the colour it marks it. */
function RequiredMark() {
  return (
    <span aria-hidden className="text-destructive">
      *
    </span>
  );
}

/**
 * A many-line answer, with the two views the host gives it. Preview rather than a toolbar: what a
 * reader needs is to see what they wrote as the issue will read, and the app already renders a
 * host's markdown exactly that way.
 */
function AnswerTextarea({
  field,
  value,
  cwd,
  environmentId,
  disabled,
  onChange,
}: {
  field: Extract<IssueTemplateQuestion, { readonly kind: "textarea" }>;
  value: string;
  cwd: string;
  environmentId: EnvironmentId;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  return (
    <>
      <ToggleGroup
        size="xs"
        variant="outline"
        aria-label="Markdown view"
        value={[previewing ? "preview" : "write"]}
        onValueChange={(next) => {
          const value = next[0];
          if (value) setPreviewing(value === "preview");
        }}
      >
        <Toggle value="write">Write</Toggle>
        <Toggle value="preview">Preview</Toggle>
      </ToggleGroup>
      {previewing ? (
        <div className="min-h-24 rounded-lg border border-border/60 px-3 py-2 text-sm">
          {value.trim().length > 0 ? (
            <HostMarkdown text={value} cwd={cwd} environmentId={environmentId} />
          ) : (
            <span className="text-muted-foreground">Nothing to preview yet.</span>
          )}
        </div>
      ) : (
        <Textarea
          id={`issue-field-${field.id}`}
          disabled={disabled}
          value={value}
          rows={5}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </>
  );
}

/** One question of a form, as the control the host asks it with. */
function TemplateField({
  field,
  answer,
  cwd,
  environmentId,
  disabled,
  onChange,
}: {
  field: IssueTemplateField;
  answer: IssueTemplateFieldAnswer | undefined;
  cwd: string;
  environmentId: EnvironmentId;
  disabled: boolean;
  onChange: (answer: IssueTemplateFieldAnswer) => void;
}) {
  if (field.kind === "markdown") {
    // Prose the form shows and never files, rendered as the markdown it is.
    return (
      <HostMarkdown
        className="text-sm"
        text={field.value}
        cwd={cwd}
        environmentId={environmentId}
      />
    );
  }

  const taken = issueTemplateAnswerOptions(answer);
  const toggleOption = (option: string, ticked: boolean) => {
    const kept = new Set(taken);
    if (ticked) kept.add(option);
    else kept.delete(option);
    onChange([...kept]);
  };

  const control = () => {
    switch (field.kind) {
      case "input":
        return (
          <Input
            id={`issue-field-${field.id}`}
            disabled={disabled}
            value={issueTemplateAnswerText(answer)}
            placeholder={field.placeholder}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      case "textarea":
        return (
          <AnswerTextarea
            field={field}
            value={issueTemplateAnswerText(answer)}
            cwd={cwd}
            environmentId={environmentId}
            disabled={disabled}
            onChange={onChange}
          />
        );
      case "dropdown": {
        const options = field.options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ));
        const shown = taken.length > 0 ? taken.join(", ") : "Select";
        // A picker rather than a list of boxes even where more than one may be taken, because that
        // is the control the host asks with and the answer reads the same either way.
        return field.multiple ? (
          <Select
            multiple
            disabled={disabled}
            value={[...taken]}
            onValueChange={(value) =>
              onChange(value.filter((option): option is string => option !== null))
            }
          >
            <SelectTrigger className="w-fit min-w-40" id={`issue-field-${field.id}`}>
              <SelectValue>{shown}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {options}
            </SelectPopup>
          </Select>
        ) : (
          <Select
            disabled={disabled}
            value={taken[0] ?? ""}
            onValueChange={(value) => onChange(value === null || value.length === 0 ? [] : [value])}
          >
            <SelectTrigger className="w-fit min-w-40" id={`issue-field-${field.id}`}>
              <SelectValue>{shown}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {options}
            </SelectPopup>
          </Select>
        );
      }
      case "checkboxes":
        return (
          <div className="space-y-2">
            {field.options.map((option) => (
              <label className="flex items-start gap-2 text-sm" key={option.label}>
                <Checkbox
                  className="mt-0.5"
                  disabled={disabled}
                  checked={taken.includes(option.label)}
                  onCheckedChange={(ticked) => toggleOption(option.label, ticked)}
                />
                <span>
                  {option.label} {option.required ? <RequiredMark /> : null}
                </span>
              </label>
            ))}
          </div>
        );
    }
  };

  return (
    <div className="space-y-1.5">
      {/* A group of boxes has no one control to name, and each box carries its own label. */}
      {field.kind === "checkboxes" ? (
        <span className="block font-medium text-sm">{field.label}</span>
      ) : (
        <label className="block font-medium text-sm" htmlFor={`issue-field-${field.id}`}>
          {field.label} {field.required ? <RequiredMark /> : null}
        </label>
      )}
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
      {control()}
    </div>
  );
}

export function IssueCreateDialog({
  open,
  onOpenChange,
  environmentId,
  projects,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  /** The projects the page is scoped to, in the order it lists them. */
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  /** What the page is currently narrowed to, which is the project to open on. */
  projectId: ProjectId | undefined;
  /** Where the issue landed, so the page can open it and re-read the list it was filed from. */
  onCreated: (created: {
    projectId: ProjectId;
    repository: string;
    number: number;
    url: string;
  }) => void;
}) {
  const [selectedId, setSelectedId] = useState<ProjectId | null>(null);
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [answers, setAnswers] = useState<IssueTemplateAnswers>({});
  const [labels, setLabels] = useState("");
  const [assignees, setAssignees] = useState("");
  const [filing, setFiling] = useState(false);
  /**
   * The same "already filing" as `filing`, kept where a second press can read it. State is only
   * true after a render, and two ⌘ Enters land inside one — which is two issues on the host.
   */
  const filingRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });

  // The page hands over the projects it lists; their repositories come from the workspace, which
  // is the only thing that knows what each one was cloned from.
  const allProjects = useProjects();
  const candidates = useMemo(() => {
    const repositoryById = new Map(
      allProjects.flatMap((project) => {
        const repository = project.repositoryIdentity
          ? repositoryOf(project.repositoryIdentity)
          : null;
        return repository === null ? [] : [[project.id, repository] as const];
      }),
    );
    return projects.flatMap((project) => {
      const repository = repositoryById.get(project.id);
      return repository === undefined ? [] : [{ ...project, repository }];
    });
  }, [allProjects, projects]);

  // What the page is scoped to, unless the reader has since chosen otherwise. Derived rather than
  // held, so a project list that arrives after the dialog opens still lands on the right one.
  const selected =
    candidates.find((project) => project.id === selectedId) ??
    candidates.find((project) => project.id === projectId) ??
    candidates[0];
  const trimmedTitle = title.trim();

  // What this repository asks a new issue to start from, read once the dialog is open and only for
  // the project it would be filed against.
  const templatesQuery = useEnvironmentQuery(
    open && selected !== undefined
      ? issueEnvironment.templates({
          environmentId,
          input: { projectId: selected.id, repository: selected.repository },
        })
      : null,
  );
  // A host with no templates to report, and a read that failed, both leave the blank form — which
  // is what a repository with no templates offers anyway. Filing must never wait on the chooser.
  const offer = templatesQuery.data ?? {
    capabilities: undefined,
    templates: [],
    contactLinks: [],
    blankIssuesEnabled: true,
    contributingGuidelinesUrl: undefined,
  };
  // What the host takes on a new issue, which the offer is the only read that answers before the
  // issue exists. A read that failed — and a server from before the offer carried it — leaves
  // everything offered, exactly where this stood before the host could say: the host then refuses
  // what it cannot do, and says why, which is better than a form nobody can reach.
  const can = offer.capabilities ?? { create: true, labels: true, assignees: true };
  // Nothing to choose between is not a choice: a repository with no templates and nowhere else to
  // send a question opens straight onto the form, exactly as the host itself does.
  const hasChoice = offer.templates.length > 0 || offer.contactLinks.length > 0;
  const choice: Choice | null = chosen ?? (hasChoice ? null : { kind: "blank" });
  const template: IssueTemplate | undefined =
    choice?.kind === "template"
      ? offer.templates.find((entry) => entry.key === choice.key)
      : undefined;
  // A template supplies questions or a draft, never both, so this is what tells the two apart.
  const fields = template?.fields ?? [];

  /** Taking a starting point writes the whole draft, so going back and taking another replaces it
   *  rather than leaving half of the last one behind. */
  const resetDraft = (taken: IssueTemplate | undefined) => {
    setTitle(taken?.title ?? "");
    setBody(taken?.body ?? "");
    setAnswers(initialAnswers(taken?.fields ?? []));
    // Into the same fields a reader types into, so what the template asks for is theirs to edit.
    setLabels((taken?.labels ?? []).join(", "));
    setAssignees((taken?.assignees ?? []).join(", "));
  };

  const choose = (next: Choice) => {
    setChosen(next);
    resetDraft(
      next.kind === "template"
        ? offer.templates.find((entry) => entry.key === next.key)
        : undefined,
    );
  };

  // Closing throws the draft away with the chooser: a draft that was abandoned is not one this
  // dialog keeps, and the next "New issue" is a new issue — on the chooser, on whatever project
  // the page is scoped to by then, with nothing of the last one still in the boxes.
  const setOpen = (next: boolean) => {
    if (!next) {
      setChosen(null);
      setSelectedId(null);
      resetDraft(undefined);
    }
    onOpenChange(next);
  };

  const complete = issueTemplateAnswersComplete(fields, answers);
  /** Whether a draft is being written at all, which a host that files nothing never gets to. */
  const composing = choice !== null && can.create;
  // Nothing has been started on the chooser, so there is nothing to file from it: the Create
  // button is absent there, but the keyboard reaches this from every step of the dialog.
  const canFile =
    selected !== undefined &&
    can.create &&
    choice !== null &&
    trimmedTitle.length > 0 &&
    complete &&
    !filing;

  const submit = async () => {
    if (selected === undefined || !canFile || filingRef.current) return;
    filingRef.current = true;
    setFiling(true);
    const result = await create({
      environmentId,
      input: {
        projectId: selected.id,
        repository: selected.repository,
        title: trimmedTitle,
        // A form is filed as the markdown its answers make, which is what the host would have
        // built from the same answers; a markdown template is filed as what the reader wrote.
        body: fields.length > 0 ? buildIssueTemplateBody(fields, answers) : body,
        // Nothing the host does not take: a set it has no notion of is dropped here rather than
        // sent and thrown away where nobody sees it happen.
        labels: can.labels ? parseList(labels) : [],
        assignees: can.assignees ? parseList(assignees) : [],
      },
    });
    filingRef.current = false;
    setFiling(false);
    if (result._tag === "Failure") {
      // The host's own sentence: a label that does not exist, a tracker switched off for this
      // repository and an account without access are three different refusals, and only the host
      // knows which one this was.
      toastManager.add({
        type: "error",
        title: "Could not file this issue",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have access to this repository, and that its issue tracker is on.",
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: `Filed issue #${result.value.number}` });
    // Filing several in a row is one job, so the same starting point comes back empty rather than
    // the dialog closing and the chooser having to be walked again.
    if (createMore) resetDraft(template);
    else setOpen(false);
    onCreated({
      projectId: selected.id,
      repository: selected.repository,
      number: result.value.number,
      url: result.value.url,
    });
  };

  const submitLabel = isMacPlatform(navigator.platform) ? "⌘ Enter" : "Ctrl Enter";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup
        className={expanded ? "max-w-4xl" : "max-w-xl"}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          void submit();
        }}
      >
        <Button
          aria-label={expanded ? "Shrink this dialog" : "Expand this dialog"}
          className="absolute end-11 top-2"
          size="icon"
          variant="ghost"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        <DialogHeader className={choice === null ? undefined : "flex-row items-center gap-2"}>
          {choice !== null && hasChoice ? (
            <Button
              aria-label="Back to the starting points"
              size="icon"
              variant="ghost"
              disabled={filing}
              onClick={() => setChosen(null)}
            >
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <DialogTitle className="min-w-0 flex-1 truncate pe-20 text-lg">
            {composing && selected !== undefined
              ? `Create new issue in ${selected.repository}${template ? `: ${template.name}` : ""}`
              : "Create new issue"}
          </DialogTitle>
          {choice === null ? (
            <DialogDescription>
              Filed on the host this project is checked out from, as you.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {selected === undefined ? (
            <p className="text-sm text-muted-foreground">
              None of these projects is checked out from a host that takes issues. Add a project
              with a GitHub, GitLab, Bitbucket or Azure DevOps remote, then file one from here.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="issue-project"
                >
                  Project
                </label>
                <Select
                  value={selected.id}
                  onValueChange={(value) => {
                    setSelectedId(value as ProjectId);
                    // Another repository asks for other things, so its own chooser comes back —
                    // and the answers go with it. A repository that offers nothing derives
                    // straight to the blank form, which never passes the chooser that would
                    // otherwise have cleared them, so they are cleared here instead.
                    setChosen(null);
                    resetDraft(undefined);
                  }}
                >
                  <SelectTrigger id="issue-project" className="w-full" aria-label="Project">
                    <SelectValue>{selected.title}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {candidates.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {/* Read-only, because it is the project's own remote rather than a choice: filing
                    against another repository is choosing another project. */}
                <Tooltip>
                  <TooltipTrigger render={<p className="truncate text-xs text-muted-foreground" />}>
                    {selected.repository}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{selected.repository}</TooltipPopup>
                </Tooltip>
              </div>

              {templatesQuery.isPending ? (
                <p className="text-sm text-muted-foreground">
                  Reading what this repository asks a new issue to start from…
                </p>
              ) : !can.create ? (
                // The host said it files nothing, so there is no form to fill in: a composer here
                // would be typing into a refusal.
                <p className="text-sm text-muted-foreground">
                  {selected.repository} is on a host that does not take new issues from here. Open
                  it on the host to file one.
                </p>
              ) : choice === null ? (
                // Hairlines rather than boxes, and the whole row is the target: this is a list to
                // walk down, not a set of cards to compare.
                <div className="divide-y divide-border/60 border-border/60 border-y">
                  {offer.templates.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => choose({ kind: "template", key: entry.key })}
                      className="flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-accent/60"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-sm">{entry.name}</span>
                        {entry.about ? (
                          <span className="block text-xs text-muted-foreground">{entry.about}</span>
                        ) : null}
                      </span>
                      <ChevronRightIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    </button>
                  ))}
                  {/* Where the repository would rather this went, opened on the host: the
                      conversation these point at is not one this page can hold. */}
                  {offer.contactLinks.map((link) => (
                    <a
                      key={link.url}
                      href={link.url}
                      rel="noreferrer noopener"
                      target="_blank"
                      className="flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-accent/60"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-sm">{link.name}</span>
                        {link.about ? (
                          <span className="block text-xs text-muted-foreground">{link.about}</span>
                        ) : null}
                      </span>
                      <ExternalLinkIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    </a>
                  ))}
                  {offer.blankIssuesEnabled ? (
                    <button
                      type="button"
                      onClick={() => choose({ kind: "blank" })}
                      className="flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-accent/60"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-sm">Blank issue</span>
                        <span className="block text-xs text-muted-foreground">
                          Create a new issue from scratch
                        </span>
                      </span>
                      <ChevronRightIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    </button>
                  ) : null}
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className="block font-medium text-sm" htmlFor="issue-title">
                      Add a title <RequiredMark />
                    </label>
                    <Input
                      id="issue-title"
                      autoFocus
                      disabled={filing}
                      value={title}
                      placeholder="What is happening, in one line"
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </div>

                  {/* What the template says it is for, where the form step is the first place a
                      reader who took it from the chooser sees it again. */}
                  {template?.about ? (
                    <p className="text-sm text-muted-foreground">{template.about}</p>
                  ) : null}

                  {fields.length > 0 ? (
                    fields.map((field, index) => (
                      <TemplateField
                        key={field.kind === "markdown" ? `markdown-${index}` : field.id}
                        field={field}
                        answer={field.kind === "markdown" ? undefined : answers[field.id]}
                        cwd={selected.workspaceRoot}
                        environmentId={environmentId}
                        disabled={filing}
                        onChange={(answer) =>
                          field.kind === "markdown"
                            ? undefined
                            : setAnswers((current) => ({ ...current, [field.id]: answer }))
                        }
                      />
                    ))
                  ) : (
                    <div className="space-y-1.5">
                      <label className="block font-medium text-sm" htmlFor="issue-body">
                        Description
                      </label>
                      <Textarea
                        id="issue-body"
                        disabled={filing}
                        value={body}
                        rows={8}
                        placeholder="Markdown. What you did, what happened, what you expected."
                        onChange={(event) => setBody(event.target.value)}
                      />
                    </div>
                  )}

                  {fields.length > 0 ? (
                    // A form's labels are the form's rather than a choice, so they are shown as
                    // what will be applied instead of as something to edit.
                    template && template.labels.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Labels</span>
                        {template.labels.map((label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    ) : null
                  ) : can.labels || can.assignees ? (
                    /* Typed rather than picked: a repository's labels and the people who may be
                    assigned are read against an issue, and this one does not exist yet. Both are
                    optional, and anything the host does not recognise it refuses by name. Each is
                    shown only where the host has the notion at all: a box whose contents are
                    dropped on the way out is worse than no box. */
                    <div className="grid gap-4 sm:grid-cols-2">
                      {can.labels ? (
                        <div className="space-y-1.5">
                          <label
                            className="text-xs font-medium text-muted-foreground"
                            htmlFor="issue-labels"
                          >
                            Labels
                          </label>
                          <Input
                            id="issue-labels"
                            disabled={filing}
                            value={labels}
                            placeholder="bug, good first issue"
                            onChange={(event) => setLabels(event.target.value)}
                          />
                        </div>
                      ) : null}
                      {can.assignees ? (
                        <div className="space-y-1.5">
                          <label
                            className="text-xs font-medium text-muted-foreground"
                            htmlFor="issue-assignees"
                          >
                            Assignees
                          </label>
                          <Input
                            id="issue-assignees"
                            disabled={filing}
                            value={assignees}
                            placeholder="octocat, hubot"
                            onChange={(event) => setAssignees(event.target.value)}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Only where the repository really keeps one: the host reported the file, so
                      this link goes somewhere rather than to a 404 with a book next to it. */}
                  {offer.contributingGuidelinesUrl ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <BookOpenIcon aria-hidden className="size-3.5 shrink-0" />
                      <span>
                        Please follow this repository's{" "}
                        <a
                          href={offer.contributingGuidelinesUrl}
                          rel="noreferrer noopener"
                          target="_blank"
                          className="underline underline-offset-2"
                        >
                          contributing guidelines
                        </a>
                        .
                      </span>
                    </p>
                  ) : null}
                </>
              )}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {composing ? (
            <label className="flex items-center gap-2 text-sm sm:me-auto">
              <Checkbox
                disabled={filing}
                checked={createMore}
                onCheckedChange={(next) => setCreateMore(next)}
              />
              Create more
            </label>
          ) : null}
          <Button variant="ghost" disabled={filing} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {/* Absent on the chooser rather than disabled: nothing has been started yet, so there is
              nothing this would file — and on a host that files nothing there never will be. */}
          {composing ? (
            <Button disabled={!canFile} onClick={() => void submit()}>
              <PlusIcon />
              {filing ? "Creating..." : "Create"}
              <Kbd>{submitLabel}</Kbd>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
