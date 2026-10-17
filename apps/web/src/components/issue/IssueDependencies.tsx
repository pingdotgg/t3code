import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueDependencyDirection,
  IssueDetail,
  IssueRef,
} from "@t3tools/contracts";
import { useState } from "react";

import { issueEnvironment, useIssueDependencies } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { IssueLoadMore } from "./IssueLoadMore";
import { RelationRow } from "./IssueRelations";
import { reportIssueResult } from "./issueMutation";

export function IssueDependencies({
  environmentId,
  reference,
  detail,
  onSelectIssue,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  onSelectIssue: (reference: IssueRef, displayKey: string, url?: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {(["blocks", "blocked-by"] as const).map((direction) => (
        <DependencySection
          key={direction}
          environmentId={environmentId}
          reference={reference}
          detail={detail}
          direction={direction}
          onSelectIssue={onSelectIssue}
        />
      ))}
    </div>
  );
}

function DependencySection({
  environmentId,
  reference,
  detail,
  direction,
  onSelectIssue,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  direction: IssueDependencyDirection;
  onSelectIssue: (reference: IssueRef, displayKey: string, url?: string) => void;
}) {
  const page = useIssueDependencies(environmentId, { ...reference, direction, limit: 100 });
  const setDependency = useAtomCommand(issueEnvironment.setDependency, { reportFailure: false });
  const permission = useAtomValue(issueEnvironment.setDependency.permissionAtom(environmentId));
  const allowed =
    detail.writable &&
    (detail.viewerPermissions.updateDependencies ?? detail.viewerPermissions.edit) &&
    detail.capabilities.dependencies === true &&
    permission;
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState(reference.scope);
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const title = direction === "blocks" ? "Blocks" : "Blocked by";
  const change = async (targetScope: string, targetKey: string, linked: boolean) => {
    if (!allowed || pending) return;
    setPending(true);
    const result = await setDependency({
      environmentId,
      input: { ...reference, direction, targetScope, targetKey, linked },
    });
    setPending(false);
    if (
      !reportIssueResult(
        result,
        linked ? "Could not add the dependency" : "Could not remove the dependency",
      )
    )
      return;
    setEditing(false);
    setKey("");
    page.refresh();
  };
  return (
    <section className="flex flex-col gap-1" aria-label={title}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <h3 className="flex-1">{title}</h3>
        {allowed ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={pending}
            onClick={() => setEditing(true)}
          >
            Add dependency
          </Button>
        ) : null}
      </div>
      {page.items.map((relation) => (
        <RelationRow
          key={relation.kind + ":" + relation.scope + ":" + relation.key}
          relation={relation}
          target={
            relation.kind === "pull-request" || relation.externalOnly
              ? null
              : { ...reference, scope: relation.scope, key: relation.key }
          }
          onSelectIssue={onSelectIssue}
          trailing={
            allowed ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={pending}
                aria-label={"Remove dependency " + relation.displayKey}
                onClick={() => void change(relation.scope, relation.key, false)}
              >
                Remove
              </Button>
            ) : null
          }
        />
      ))}
      {page.items.length === 0 && page.error === null ? (
        <p className="px-2 text-xs text-muted-foreground">{page.isPending ? "Loading…" : "None"}</p>
      ) : null}
      {page.error && page.items.length === 0 ? (
        <p role="alert" className="text-xs text-muted-foreground">
          The dependencies could not be read. {page.error}
        </p>
      ) : null}
      {page.error ? (
        <Button size="xs" variant="outline" disabled={page.isPending} onClick={page.refresh}>
          Retry dependencies
        </Button>
      ) : null}
      {page.truncated && page.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The tracker returned part of this list. Open it on the tracker for the rest.
        </p>
      ) : null}
      <IssueLoadMore page={page} label="Load more dependencies" />
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!pending) setEditing(open);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{title}: add dependency</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Label htmlFor={"dependency-scope-" + direction}>Target scope</Label>
            <Input
              id={"dependency-scope-" + direction}
              value={scope}
              disabled={pending || !allowed}
              onChange={(event) => setScope(event.target.value)}
            />
            <Label htmlFor={"dependency-key-" + direction}>Target key</Label>
            <Input
              id={"dependency-key-" + direction}
              value={key}
              disabled={pending || !allowed}
              onChange={(event) => setKey(event.target.value)}
            />
            {!allowed ? <p role="alert">You cannot change dependencies here.</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={pending || !allowed || !scope.trim() || !key.trim()}
              onClick={() => void change(scope.trim(), key.trim(), true)}
            >
              {pending ? "Saving…" : "Add dependency"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
