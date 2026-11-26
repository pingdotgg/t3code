// Fork: Kaluwa's Extensions page. MCP servers, plugins and skills for every subscription.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  extensionsAtom,
  extensionsFastListAtom,
  extensionsHealthCheckAtom,
  extensionsMutate,
} from "../../state/extensions";
import { formatEnvironmentQueryError } from "../../state/query";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { ExtensionsWorkspace } from "./ExtensionsWorkspace";
import { useExtensionsActions } from "./useExtensionsActions";

function ExtensionsBody({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const m = useMessages();
  const list = useAtomValue(extensionsAtom(environmentId));
  const fast = useAtomValue(extensionsFastListAtom(environmentId));
  const refreshFast = useAtomRefresh(extensionsFastListAtom(environmentId));
  // Reading this is what checks MCP health when the page opens.
  const check = useAtomValue(extensionsHealthCheckAtom(environmentId));
  const refreshCheck = useAtomRefresh(extensionsHealthCheckAtom(environmentId));
  const canEdit = useAtomValue(extensionsMutate.permissionAtom(environmentId));
  const { pending, run } = useExtensionsActions(environmentId, list?.subscriptions ?? []);
  return (
    <ExtensionsWorkspace
      list={list}
      loadError={
        fast._tag === "Failure" && !fast.waiting ? formatEnvironmentQueryError(fast.cause, m) : null
      }
      canEdit={canEdit}
      checking={check.waiting || check._tag === "Initial"}
      checkFailed={check._tag === "Failure"}
      pending={pending}
      run={run}
      recheck={() => {
        refreshFast();
        refreshCheck();
      }}
      close={<AppRouteModalClose />}
    />
  );
}

export function ExtensionsPage() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  return (
    <AppRouteModal label={gt("Extensions")}>
      {environmentId === null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex min-h-12 shrink-0 items-center justify-between border-b ps-5 pe-2">
            <span className="text-sm font-medium">
              <T>Extensions</T>
            </span>
            <AppRouteModalClose />
          </header>
          <p className="p-6 text-sm text-muted-foreground">
            <T>Connect an environment to see its extensions.</T>
          </p>
        </div>
      ) : (
        <ExtensionsBody key={environmentId} environmentId={environmentId} />
      )}
    </AppRouteModal>
  );
}
