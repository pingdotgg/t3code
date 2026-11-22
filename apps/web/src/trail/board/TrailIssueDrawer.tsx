import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import type {
  EnvironmentId,
  IssueListEntry,
  IssueRef,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { IssueDetailPanel } from "~/components/issue/IssueDetailPanel";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";

import { TrailAcceptanceCriteria } from "./TrailAcceptanceCriteria";

export type TrailIssueSelection = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly tracker: IssueTrackerKind;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
};

export function TrailIssueDrawer({
  open,
  selection,
  listEntry,
  onOpenChange,
}: {
  open: boolean;
  selection: TrailIssueSelection | null;
  listEntry: EnvironmentIssueEntry | IssueListEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const reference: IssueRef | null =
    selection === null
      ? null
      : {
          projectId: selection.projectId,
          tracker: selection.tracker,
          ...(selection.host ? { host: selection.host } : {}),
          scope: selection.scope,
          key: selection.key,
        };
  const detailQuery = useEnvironmentQuery(
    selection && reference
      ? issueEnvironment.detail({ environmentId: selection.environmentId, input: reference })
      : null,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        side="right"
        className="flex w-full max-w-xl flex-col sm:max-w-xl"
        showCloseButton
      >
        <SheetHeader className="text-left">
          <SheetTitle>
            {listEntry?.displayKey ?? selection?.key ?? gt("Issue")}
            {listEntry?.title ? (
              <span className="mt-0.5 block truncate text-sm font-normal text-muted-foreground">
                {listEntry.title}
              </span>
            ) : null}
          </SheetTitle>
          <SheetDescription className="sr-only">
            <T>Issue details</T>
          </SheetDescription>
        </SheetHeader>
        {selection && reference ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TrailAcceptanceCriteria body={detailQuery.data?.body} />
              <div className="h-[min(80vh,720px)] min-h-0">
                <IssueDetailPanel
                  environmentId={selection.environmentId}
                  reference={reference}
                  listEntry={listEntry}
                />
              </div>
            </div>
          </div>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
