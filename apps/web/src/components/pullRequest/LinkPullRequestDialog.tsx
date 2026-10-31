import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  pullRequestLinkProject,
  resolveLinkPullRequestInput,
} from "@t3tools/client-runtime/pull-request-link-input";
import { useAtomValue } from "@effect/atom-react";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";

import { usePullRequestPreviewTarget } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";
import { useProjects, useThreadShell } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Atom } from "effect/reactivity";
import { SourceControlIconArtwork } from "../SourceControlIconArtwork";
import { SubmitKbd } from "../SubmitKbd";
import { Badge } from "../ui/badge";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { resolvePullRequestState } from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";

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

export function LinkPullRequestDialogHost() {
  const threadRef = useAtomValue(linkPullRequestDialogThreadAtom);
  const thread = useThreadShell(threadRef);
  const linking = usePullRequestLinking(threadRef?.environmentId);
  if (threadRef === null || linking.mode === "unsupported") return null;
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
  // Typing a URL resolves a new number per keystroke; only ask the host once it settles.
  const settledUrl = useDebouncedValue(link.url, 300);
  const target = usePullRequestPreviewTarget(environmentId, settledUrl);
  const preview = useEnvironmentQuery(
    target !== null && settledUrl === link.url ? pullRequestEnvironment.preview(target) : null,
  ).data;
  if (preview === null) {
    return (
      <p className="truncate text-muted-foreground text-meta">
        {link.host}/{link.repository} #{link.number}
      </p>
    );
  }
  const state = resolvePullRequestState({ state: preview.state, isDraft: preview.isDraft });
  const stateKey = preview.state === "open" && preview.isDraft ? "draft" : preview.state;
  const author = preview.author?.login ?? "ghost";
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-control border border-border surface-card px-3 py-2.5">
      <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-foreground text-label">{preview.title}</p>
        <p className="truncate text-dim-foreground text-meta">
          #{preview.number} · {author} opened <RelativeTime timestamp={preview.createdAt} />
        </p>
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
  const inputRef = useRef<HTMLInputElement>(null);
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

  const resolved = resolveLinkPullRequestInput({
    reference,
    project: ownProject,
    hasProject: (reference) => linking.canLink(reference.url),
  });

  const submit = async () => {
    setDirty(true);
    if (resolved === null || "error" in resolved) return;
    setSubmitError(null);
    setPending(true);
    const result = await settlePromise(() =>
      linking.changeLink(threadRef, resolved.link.url, true),
    );
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setSubmitError(
        error instanceof Error ? error.message : `Could not link the ${terminology.singular}.`,
      );
      return;
    }
    onOpenChange(false);
  };

  const validation = !dirty
    ? null
    : reference.trim().length === 0
      ? `Paste a ${terminology.singular} URL or enter 123 / #123.`
      : resolved === null
        ? `Use a ${terminology.singular} URL, 123, or #123.`
        : "error" in resolved
          ? resolved.error
          : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-110" initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>Link {terminology.singular}</DialogTitle>
          <DialogDescription>
            Paste a {terminology.singular} URL or enter 123 / #123.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <InputGroup>
            <InputGroupAddon>
              {definition.icon === null ? (
                <PullRequestGlyph.pullRequest />
              ) : (
                <SourceControlIconArtwork icon={definition.icon} />
              )}
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              aria-label={`${capitalizeTerm(terminology.singular)} URL or number`}
              font="mono"
              placeholder={`${capitalizeTerm(terminology.singular)} URL or #42`}
              value={reference}
              onChange={(event) => {
                setDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void submit();
              }}
            />
          </InputGroup>
          {resolved !== null && "link" in resolved ? (
            <LinkPullRequestPreview environmentId={threadRef.environmentId} link={resolved.link} />
          ) : null}
          {(validation ?? submitError) ? (
            <p className="text-destructive text-meta">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || resolved === null || "error" in resolved}
          >
            {pending ? "Linking..." : "Link"}
            <SubmitKbd />
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
