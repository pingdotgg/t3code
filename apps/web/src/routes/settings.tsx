import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { SettingsScopePicker } from "../components/settings/SettingsScopePicker";
import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SettingsRowScopeProvider } from "../components/settings/settingsLayout";
import { Link } from "@tanstack/react-router";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";

function RestoreDeviceDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Restore device defaults
    </Button>
  );
}

function SettingsTargetBar() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const {
    search,
    scope,
    selectScope,
    environments: selected,
    connectedEnvironments,
  } = useSettingsScope();
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  if (pathname === "/settings/connections") {
    return (
      <WorkspacePageContainer className="pb-0">
        <p className="text-xs text-muted-foreground">
          Manage this client's connections. Environment controls below name the server they affect.
        </p>
      </WorkspacePageContainer>
    );
  }
  return (
    <div className="scrollbar-gutter-both shrink-0 overflow-y-auto">
      <WorkspacePageContainer className="items-start gap-2 pb-0">
        <SettingsScopePicker
          value={search}
          groups={groups}
          environments={environments}
          onChange={selectScope}
          includeDevice
        />
        <p className="text-xs text-muted-foreground">
          {scope.kind === "device"
            ? "Preferences saved on this device."
            : scope.kind === "all"
              ? `Changes apply to ${connectedEnvironments.length} connected environment${connectedEnvironments.length === 1 ? "" : "s"}. Offline environments keep their current settings.`
              : scope.kind === "environment"
                ? `Defaults for projects on ${scope.label}.${connectedEnvironments.length === 0 ? " Reconnect to make changes." : ""}`
                : scope.kind === "project"
                  ? `Changes apply to ${scope.members.length} checkout${scope.members.length === 1 ? "" : "s"} across ${selected.length} environment${selected.length === 1 ? "" : "s"}.`
                  : scope.kind === "checkout"
                    ? scope.checkout.workspaceRoot
                    : scope.kind === "unavailable"
                      ? scope.message
                      : ""}
        </p>
      </WorkspacePageContainer>
    </div>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, search, connectedEnvironments } = useSettingsScope();
  if (pathname === "/settings/snap-shot" && scope.kind !== "device") {
    return (
      <SettingsScopeNotice target="device">
        SnapShots are configured on this device.
      </SettingsScopeNotice>
    );
  }
  // Keep the project editor mounted while a grouping change replaces its URL key.
  if (pathname === "/settings/projects" || pathname === "/settings/connections") return children;
  if (scope.kind === "unavailable")
    return <p className="p-8 text-sm text-muted-foreground">{scope.message}</p>;
  if (pathname === "/settings/archived" && scope.kind !== "device") return children;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Project overrides are available in{" "}
        <Link className="text-primary underline" to="/settings/projects" search={search}>
          Project settings
        </Link>
        .
      </div>
    );
  }
  if (
    ["/settings/appearance", "/settings/integrations"].includes(pathname) &&
    scope.kind !== "device"
  ) {
    return (
      <SettingsScopeNotice target="device">
        These preferences belong to this device, not an environment or project.
      </SettingsScopeNotice>
    );
  }
  if (
    ["/settings/providers", "/settings/keybindings", "/settings/diagnostics"].includes(pathname) &&
    scope.kind !== "environment"
  ) {
    return (
      <SettingsScopeNotice target="environment">
        Choose one environment to manage these settings.
      </SettingsScopeNotice>
    );
  }
  if (
    ["/settings/source-control", "/settings/archived"].includes(pathname) &&
    scope.kind === "device"
  ) {
    return (
      <SettingsScopeNotice target="all">
        Choose an environment to view these settings.
      </SettingsScopeNotice>
    );
  }
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        Reconnect {scope.label} to change its settings.
      </p>
    );
  }
  return pathname === "/settings/general" || pathname === "/settings/source-control" ? (
    <SettingsRowScopeProvider>{children}</SettingsRowScopeProvider>
  ) : (
    children
  );
}

function SettingsContentLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { search, scope } = useSettingsScope();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();

        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
          activeElement.blur();
        }

        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full items-center gap-3">
            <SettingsBreadcrumb pathname={location.pathname} />
            {location.pathname === "/settings/general" && scope.kind === "device" ? (
              <div className="ms-auto">
                <RestoreDeviceDefaultsButton
                  onRestored={() => setRestoreSignal((value) => value + 1)}
                />
              </div>
            ) : null}
          </div>
        </WorkspacePageHeader>

        <SettingsTargetBar />
        <div
          key={`${JSON.stringify(search)}:${restoreSignal}`}
          className="min-h-0 flex flex-1 flex-col"
        >
          <SettingsScopeBoundary pathname={location.pathname}>
            <Outlet />
          </SettingsScopeBoundary>
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = Object.values(rawSearch).some((value) => value !== undefined)
    ? rawSearch
    : { scope: "device" as const };
  return (
    <SettingsScopeProvider
      search={search}
      onChange={(next) => {
        void navigate({ to: pathname, search: () => next, hash: "", resetScroll: false });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
