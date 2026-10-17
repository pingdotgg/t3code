import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, IssueDetail, IssueRef, IssueRelation } from "@t3tools/contracts";
import { ExternalLinkIcon, PlusIcon, UnlinkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { issueEnvironment, useIssueHierarchy } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { PULL_REQUEST_ROW_NUMBER_CLASS } from "../pullRequest/PullRequestListRow";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { IssueLoadMore } from "./IssueLoadMore";
import { reportIssueResult } from "./issueMutation";
import { IssueStateGlyph } from "./issuePresentation";

const ROW_CLASS =
  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60";

function SectionTitle({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
      <h3 className="flex-1">{title}</h3>
      {actions}
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="px-2 text-xs text-muted-foreground">{children}</p>;
}

export function RelationRow({
  relation,
  target,
  onSelectIssue,
  trailing,
}: {
  relation: IssueRelation;
  target: IssueRef | null;
  onSelectIssue: ((reference: IssueRef, displayKey: string, url?: string) => void) | undefined;
  trailing?: ReactNode;
}) {
  const inApp = relation.externalOnly !== true && target !== null && onSelectIssue !== undefined;
  const body = (
    <>
      <IssueStateGlyph state={relation.state} className="size-3.5" />
      <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{relation.displayKey}</span>
      <span className="min-w-0 flex-1 truncate">{relation.title}</span>
      {inApp ? null : (
        <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      )}
    </>
  );
  return (
    <div className="flex items-center gap-1">
      {inApp ? (
        <button
          type="button"
          className={ROW_CLASS}
          onClick={() => onSelectIssue(target, relation.displayKey, relation.url)}
        >
          {body}
        </button>
      ) : (
        <a href={relation.url} target="_blank" rel="noopener noreferrer" className={ROW_CLASS}>
          {body}
        </a>
      )}
      {trailing}
    </div>
  );
}

export function IssueHierarchySection({
  environmentId,
  reference,
  detail,
  onSelectIssue,
  onCreateSubIssue,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  onSelectIssue: ((reference: IssueRef, displayKey: string, url?: string) => void) | undefined;
  onCreateSubIssue: (() => void) | null;
}) {
  const hierarchy = useIssueHierarchy(environmentId, reference);
  const setParent = useAtomCommand(issueEnvironment.setParent, { reportFailure: false });
  const parentAllowed = useAtomValue(issueEnvironment.setParent.permissionAtom(environmentId));
  const canSetParent =
    detail.writable &&
    detail.capabilities.updateParent === true &&
    (detail.viewerPermissions.updateParent ?? detail.viewerPermissions.edit) &&
    parentAllowed;
  const [parentDraft, setParentDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const noun = detail.capabilities.subIssueNoun ?? "Sub-issues";
  const parent = hierarchy.extra;
  const loading = hierarchy.isPending && hierarchy.items.length === 0 && parent === null;

  const changeParent = async (parentKey: string | null) => {
    if (!canSetParent || pending) return;
    setPending(true);
    const result = await setParent({ environmentId, input: { ...reference, parentKey } });
    setPending(false);
    if (
      !reportIssueResult(
        result,
        parentKey === null ? "Could not remove the parent" : "Could not set the parent",
      )
    )
      return;
    setParentDraft(null);
  };

  return (
    <section className="space-y-1" aria-label="Hierarchy">
      <SectionTitle
        title="Parent"
        actions={
          canSetParent && parent === null && parentDraft === null ? (
            <Button size="xs" variant="ghost-muted" onClick={() => setParentDraft("")}>
              <PlusIcon className="size-3" />
              Set parent
            </Button>
          ) : null
        }
      />
      {parent ? (
        <RelationRow
          relation={parent}
          target={{ ...reference, scope: parent.scope, key: parent.key }}
          onSelectIssue={onSelectIssue}
          trailing={
            canSetParent ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Remove parent"
                disabled={pending}
                onClick={() => void changeParent(null)}
              >
                <UnlinkIcon className="size-3" />
              </Button>
            ) : null
          }
        />
      ) : parentDraft !== null ? (
        <form
          className="flex items-center gap-2 px-2"
          onSubmit={(event) => {
            event.preventDefault();
            const key = parentDraft.trim().replace(/^#/, "");
            if (key) void changeParent(key);
          }}
        >
          <Input
            autoFocus
            size="sm"
            value={parentDraft}
            placeholder="Parent issue key"
            aria-label="Parent issue key"
            disabled={pending || !canSetParent}
            onChange={(event) => setParentDraft(event.target.value)}
          />
          <Button
            size="xs"
            type="submit"
            disabled={pending || !canSetParent || !parentDraft.trim()}
          >
            Save
          </Button>
          <Button size="xs" variant="ghost" type="button" onClick={() => setParentDraft(null)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Muted>{loading ? "Loading" : "No parent issue."}</Muted>
      )}
      <SectionTitle
        title={noun}
        actions={
          onCreateSubIssue ? (
            <Button size="xs" variant="ghost-muted" onClick={onCreateSubIssue}>
              <PlusIcon className="size-3" />
              {detail.capabilities.subIssueNoun
                ? `New ${detail.capabilities.subIssueNoun.toLowerCase().replace(/s$/, "")}`
                : "New sub-issue"}
            </Button>
          ) : null
        }
      />
      {hierarchy.error !== null && hierarchy.items.length === 0 ? (
        <Muted>The hierarchy could not be read. {hierarchy.error}</Muted>
      ) : hierarchy.items.length === 0 ? (
        <Muted>{loading ? "Loading" : `No ${noun.toLowerCase()}.`}</Muted>
      ) : (
        hierarchy.items.map((child) => (
          <RelationRow
            key={`${child.scope}#${child.key}`}
            relation={child}
            target={{ ...reference, scope: child.scope, key: child.key }}
            onSelectIssue={onSelectIssue}
          />
        ))
      )}
      <IssueLoadMore
        key={JSON.stringify([environmentId, reference])}
        page={hierarchy}
        label={`Load more ${noun.toLowerCase()}`}
      />
    </section>
  );
}
