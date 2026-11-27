import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  pullRequestLinkProject,
  resolveLinkPullRequestInput,
} from "@t3tools/client-runtime/pull-request-link-input";
import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useLayoutEffect, useRef, useState } from "react";
import { m } from "~/i18n/messages";
import { observeResize } from "~/lib/observeResize";

import { usePullRequestPreviewTarget } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useProjects, useThreadShell } from "~/state/entities";
import { linkedPullRequestDetailAtom } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Atom } from "effect/reactivity";
import { SubmitKbd } from "../SubmitKbd";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { resolvePullRequestState } from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";
import { changeRequestTermKind } from "./changeRequestTerm";

// Host in chat to survive command palette dismissal.
const linkPullRequestDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pull-requests:link-dialog-thread"),
);

export function openLinkPullRequestDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkPullRequestDialogThreadAtom, threadRef);
}

interface LinkPullRequestDialogProps {
  open: boolean;
  threadRef: ScopedThreadRef;
  projectId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function LinkPullRequestDialogHost({ hostThreadRef }: { hostThreadRef?: ScopedThreadRef }) {
  const threadRef = useAtomValue(linkPullRequestDialogThreadAtom);
  const thread = useThreadShell(threadRef);
  const linking = usePullRequestLinking(threadRef?.environmentId);
  if (threadRef === null || linking.mode === "unsupported") return null;
  // Retained chat views share the dialog atom; only its thread owns the overlay.
  if (
    hostThreadRef !== undefined &&
    (hostThreadRef.environmentId !== threadRef.environmentId ||
      hostThreadRef.threadId !== threadRef.threadId)
  )
    return null;
  return (
    <LinkPullRequestDialog
      open
      threadRef={threadRef}
      projectId={thread?.projectId ?? null}
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(linkPullRequestDialogThreadAtom, null);
      }}
    />
  );
}

interface ResolvedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

const STATE_BADGE_VARIANT = {
  open: "success",
  draft: "secondary",
  closed: "error",
  merged: "merged",
} as const;

/**
 * The pull request an input resolves to: its title, author and state once the host answers,
 * and the bare host/repo #N line while it loads or when this environment can't read it.
 */
function LinkPullRequestPreview({
  environmentId,
  link,
}: {
  environmentId: EnvironmentId;
  link: ResolvedLink;
}) {
  const messages = useMessages();
  // Typing a URL resolves a new number per keystroke; only ask the host once it settles.
  const settledUrl = useDebouncedValue(link.url, 300);
  const target = usePullRequestPreviewTarget(environmentId, settledUrl);
  const preview = useEnvironmentQuery(
    target !== null && settledUrl === link.url ? linkedPullRequestDetailAtom(target) : null,
  ).data;
  if (preview === null) {
    return (
      <p className="truncate text-muted-foreground text-meta">
        {link.host}/{link.repository} #{link.number}
      </p>
    );
  }
  const state = resolvePullRequestState(
    {
      state: preview.state,
      isDraft: preview.isDraft ?? false,
    },
    messages,
  );
  const stateKey = preview.state === "open" && preview.isDraft ? "draft" : preview.state;
  const author = preview.author?.login ?? "ghost";
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border surface-card px-3 py-2.5">
      <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-foreground text-label">{preview.title}</p>
        <div className="flex min-w-0 items-baseline gap-1.5 text-dim-foreground text-meta">
          <span className="shrink-0">#{preview.number}</span>
          <p className="truncate">
            <T>
              <Var>{author}</Var> wants to merge into <Var>{preview.baseBranch}</Var>
            </T>
          </p>
        </div>
      </div>
      <Badge variant={STATE_BADGE_VARIANT[stateKey]}>{state.label}</Badge>
    </div>
  );
}

function LinkPullRequestDialog({
  open,
  threadRef,
  projectId,
  onOpenChange,
}: LinkPullRequestDialogProps) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [contentInset, setContentInset] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Align the portaled dialog with the actual content bounds, including a resized or collapsed sidebar.
  useLayoutEffect(() => {
    const content = document.querySelector<HTMLElement>("main[data-slot=sidebar-inset]");
    if (!content) return;
    const update = () => {
      const bounds = content.getBoundingClientRect();
      setContentInset(bounds.left - (window.innerWidth - bounds.right));
    };
    update();
    return observeResize(content, update);
  }, []);
  const [reference, setReference] = useState("");
  const [dirty, setDirty] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const projects = useProjects();
  const project = projects.find(
    (project) => project.environmentId === threadRef.environmentId && project.id === projectId,
  );
  const ownProject = pullRequestLinkProject(project?.repositoryIdentity);
  const definition =
    sourceControlClients.findByChangeRequestUrl(reference.trim()) ??
    sourceControlClients.get(
      project?.repositoryIdentity?.provider ?? (ownProject === null ? undefined : "unknown"),
    );
  const terminology = definition.changeRequest;
  const linking = usePullRequestLinking(threadRef.environmentId);
  const [pending, setPending] = useState(false);

  const [openSeen, setOpenSeen] = useState(open);
  if (openSeen !== open) {
    setOpenSeen(open);
    if (open) {
      setReference("");
      setDirty(false);
      setSubmitError(null);
    }
  }

  const resolved = resolveLinkPullRequestInput(
    {
      reference,
      project: ownProject,
      hasProject: (reference) => linking.canLink(reference.url),
    },
    resolveMessage,
  );

  const submit = async () => {
    if (submittingRef.current) return;
    setDirty(true);
    if (resolved === null || "error" in resolved) return;
    submittingRef.current = true;
    setSubmitError(null);
    setPending(true);
    const result = await settlePromise(() =>
      linking.changeLink(threadRef, resolved.link.url, true),
    );
    submittingRef.current = false;
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setSubmitError(
        thrownErrorMessage(error, m) ??
          m(
            msg(
              "Could not link the {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term: changeRequestTermKind(terminology) },
            ),
          ),
      );
      return;
    }
    onOpenChange(false);
  };

  const validation = !dirty
    ? null
    : reference.trim().length === 0
      ? gt(
          "Paste a {term, select, mr {merge request} cr {change request} other {pull request}} URL or enter 123 / #123.",
          { term: changeRequestTermKind(terminology) },
        )
      : resolved === null
        ? gt(
            "Use a {term, select, mr {merge request} cr {change request} other {pull request}} URL, 123, or #123.",
            { term: changeRequestTermKind(terminology) },
          )
        : "error" in resolved
          ? resolved.error
          : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup
        className="max-w-110"
        initialFocus={inputRef}
        showCloseButton={false}
        placement="content-top"
        contentInset={contentInset}
      >
        <div className="flex min-h-0 flex-col gap-4 px-5 pt-5 pb-4 [--type-body:0.8125rem] [--type-label:0.8125rem] [--type-prompt:0.8125rem]">
          <div className="flex flex-col gap-1">
            <div className="[--type-label:0.9375rem]">
              <DialogTitle>
                {gt(
                  "Link {term, select, mr {merge request} cr {change request} other {pull request}}",
                  { term: changeRequestTermKind(terminology) },
                )}
              </DialogTitle>
            </div>
            <DialogDescription>
              {gt(
                "Paste a {term, select, mr {merge request} cr {change request} other {pull request}} URL or enter 123 / #123.",
                { term: changeRequestTermKind(terminology) },
              )}
            </DialogDescription>
          </div>
          <div className="flex flex-col gap-4">
            <InputGroup>
              <InputGroupAddon>
                <PullRequestGlyph.link />
              </InputGroupAddon>
              <InputGroupInput
                ref={inputRef}
                size="sm"
                aria-invalid={validation !== null || submitError !== null}
                aria-label={gt(
                  "{term, select, mr {Merge request} cr {Change request} other {Pull request}} URL or number",
                  { term: changeRequestTermKind(terminology) },
                )}
                font="mono"
                placeholder={gt(
                  "{term, select, mr {Merge request} cr {Change request} other {Pull request}} URL or #42",
                  { term: changeRequestTermKind(terminology) },
                )}
                value={reference}
                readOnly={pending}
                onChange={(event) => {
                  setDirty(true);
                  setReference(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.repeat ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  ) {
                    return;
                  }
                  event.preventDefault();
                  void submit();
                }}
              />
            </InputGroup>
            {resolved !== null && "link" in resolved ? (
              <LinkPullRequestPreview
                environmentId={threadRef.environmentId}
                link={resolved.link}
              />
            ) : null}
            {(validation ?? submitError) ? (
              <p role="alert" className="text-destructive text-meta">
                {validation ?? submitError}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              <T>Cancel</T>
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void submit()}
              disabled={pending || resolved === null || "error" in resolved}
            >
              {pending ? gt("Linking...") : gt("Link", { $context: "verb, button" })}
              <SubmitKbd />
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
