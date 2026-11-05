import { useAtom } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { lazy, Suspense, useEffect } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useRightPanelStore } from "~/rightPanelStore";
import { codeExplorerRequestAtom } from "./openCodeExplorer";

// Ordinary chat never loads the explorer; its chunk arrives the first time one opens.
const CodeExplorer = lazy(() => import("./CodeExplorer"));

export function CodeExplorerDialogHost(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const [request, setRequest] = useAtom(codeExplorerRequestAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the keep-alive request atom on unmount so a stale request cannot reopen the dialog
  useEffect(() => () => setRequest(null), [setRequest]);
  const active =
    request !== null &&
    request.environmentId === props.environmentId &&
    request.projectId === props.projectId
      ? request
      : null;
  return (
    <Dialog
      open={active !== null}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
    >
      <DialogPopup className="max-w-6xl">
        <DialogHeader>
          <DialogTitle>Code explorer</DialogTitle>
          <DialogDescription>
            Static callers and callees around a symbol, read from this checkout's code index.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {active ? (
            <Suspense
              fallback={
                <p role="status" className="text-sm text-muted-foreground">
                  Opening code explorer…
                </p>
              }
            >
              <CodeExplorer
                key={active.key}
                environmentId={active.environmentId}
                projectId={active.projectId}
                serverThreadId={active.serverThreadId}
                symbol={active.symbol}
                onOpen={(path, line) => {
                  setRequest(null);
                  useRightPanelStore.getState().openFile(active.threadRef, path, line);
                }}
              />
            </Suspense>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
