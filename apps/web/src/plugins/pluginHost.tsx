import { type PluginId, type PluginRouteId, type PluginRouteSurface } from "@t3tools/contracts";
import { useNavigate, type AnyRouter } from "@tanstack/react-router";
import * as React from "react";
import { useEffect, useMemo } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";
import {
  claimPluginKeybindingCommand,
  isActiveClientPluginKeybindingCommand,
} from "./pluginKeybindingBridge";
import { type PluginRouteReadiness, resolvePluginRouteReadiness } from "./pluginNavigation";
import { startPluginHost } from "./pluginHostRuntime";
import { usePluginHostState as usePluginHostStateFromStore } from "./pluginHostStore";
import {
  createPluginContextBase,
  createPluginRouteContext,
  PluginUiErrorBoundary,
  usePluginUiRegistration,
} from "./pluginUiRuntime";

export { usePluginCatalog, usePluginHostState } from "./pluginHostStore";

export { claimPluginKeybindingCommand, isActiveClientPluginKeybindingCommand };

export {
  PluginComposerActions,
  type PluginComposerActionStateChange,
  type PluginComposerActionStateUpdate,
} from "./pluginComposerActions";

export function PluginHostBootstrap() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  useEffect(() => {
    return startPluginHost(
      getPrimaryEnvironmentConnection().client,
      String(primaryEnvironmentId ?? "primary"),
    );
  }, [primaryEnvironmentId]);

  return null;
}

function PluginRouteReadyView({
  readiness,
  routeId,
  surface,
}: {
  readonly readiness: Extract<PluginRouteReadiness, { readonly status: "ready" }>;
  readonly routeId: PluginRouteId;
  readonly surface: PluginRouteSurface;
}) {
  const navigate = useNavigate<AnyRouter>();
  const baseContext = useMemo(
    () =>
      createPluginContextBase({
        cacheKey: readiness.factoryKey,
        client: readiness.client,
        catalogEntry: readiness.catalogEntry,
        navigate,
      }),
    [readiness.client, readiness.catalogEntry, readiness.factoryKey, navigate],
  );
  const context = useMemo(
    () =>
      createPluginRouteContext({
        baseContext,
        routeId,
        routeSurface: surface,
      }),
    [baseContext, routeId, surface],
  );
  const registrationState = usePluginUiRegistration({
    cacheKey: readiness.factoryKey,
    factory: readiness.factory,
  });
  if (registrationState.status === "loading") {
    return <PluginRouteShell surface={surface} title="Loading plugin" />;
  }
  if (registrationState.status === "failed") {
    return (
      <PluginRouteShell
        surface={surface}
        title="Plugin route unavailable"
        description={registrationState.message}
      />
    );
  }
  const route = registrationState.registration.routes[routeId];
  if (!route) {
    return <PluginRouteShell surface={surface} title="Plugin route unavailable" />;
  }
  return (
    <PluginUiErrorBoundary
      resetKey={[readiness.factoryKey, routeId].join("\u0000")}
      renderError={(error) => (
        <PluginRouteShell
          surface={surface}
          title="Plugin route unavailable"
          description={error.message || "Plugin UI crashed while rendering."}
        />
      )}
    >
      {React.createElement(route, { ctx: context })}
    </PluginUiErrorBoundary>
  );
}

export function PluginRouteView({
  pluginId,
  routeId,
  surface,
}: {
  readonly pluginId: PluginId;
  readonly routeId: PluginRouteId;
  readonly surface: PluginRouteSurface;
}) {
  const hostState = usePluginHostStateFromStore();
  const readiness = useMemo(
    () => resolvePluginRouteReadiness({ hostState, pluginId, routeId, surface }),
    [hostState, pluginId, routeId, surface],
  );

  if (readiness.status === "loading") {
    return <PluginRouteShell surface={surface} title="Loading plugin" />;
  }

  if (readiness.status === "failed") {
    return (
      <PluginRouteShell
        surface={surface}
        title={`${readiness.catalogEntry.manifest.name} failed to start`}
        description={readiness.catalogEntry.status.diagnostics?.join("\n") ?? "No diagnostics."}
      />
    );
  }

  if (readiness.status === "missing") {
    return (
      <PluginRouteShell
        surface={surface}
        title="Plugin unavailable"
        description={readiness.message}
      />
    );
  }

  return <PluginRouteReadyView readiness={readiness} routeId={routeId} surface={surface} />;
}

function PluginRouteShell({
  surface,
  title,
  description,
}: {
  readonly surface: PluginRouteSurface;
  readonly title: string;
  readonly description?: string;
}) {
  const content = (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-base font-medium">{title}</h1>
        {description ? (
          <p className="mt-2 whitespace-pre-wrap text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
    </div>
  );

  return surface === "settings" ? (
    content
  ) : (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      {content}
    </SidebarInset>
  );
}
