import { workspaceAreaProps } from "../lib/workspaceFocus";
import { Outlet, createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RestoreDeviceDefaultsButton } from "../components/settings/SettingsPanels";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { useLayoutPageLocation } from "../layout/pageNavigation";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/settingsScopeAxis";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { useRenderedSettingsPathname } from "../components/settings/useRenderedSettingsPathname";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
} from "../components/settings/settingsSearch";

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const gt = useGT();
  const m = useMessages();
  // A pending navigation's hash targets the page still loading, not the one on screen.
  const location = useLayoutPageLocation();
  const hash = location.pathname === pathname ? location.hash : "";
  const searchTarget = getSettingsSearchTargetScope(hash);
  const agentFeedbackAvailability = searchTarget?.agentFeedbackOnly
    ? {
        eligibleEnvironmentIds: environments
          .filter(
            (environment) =>
              environment.connection.phase === "connected" &&
              environment.serverConfig?.environment.capabilities.agentFeedback === true,
          )
          .map((environment) => environment.environmentId),
        isTargetAvailable:
          connectedEnvironments.length > 0 &&
          connectedEnvironments.every(
            (environment) =>
              environment.serverConfig?.environment.capabilities.agentFeedback === true,
          ),
      }
    : null;
  const targetAvailability =
    agentFeedbackAvailability ??
    (searchTarget?.requiresThreadAutoSettlement
      ? getThreadAutoSettlementSearchAvailability(environments, scope)
      : null);
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    targetAvailability &&
    !targetAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={targetAvailability.eligibleEnvironmentIds}
      >
        {targetAvailability.eligibleEnvironmentIds.length > 0
          ? gt("{title} requires a supporting environment. Choose one to continue.", {
              title: m(searchTarget.title),
            })
          : gt(
              "{title} requires a supporting environment. Connect or update an environment to continue.",
              { title: m(searchTarget.title) },
            )}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {gt(
          "{title} is not available for the selected target. Choose its owning scope to continue.",
          { title: m(searchTarget.title) },
        )}
      </SettingsScopeNotice>
    );
  }
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-body text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <p className="text-body text-muted-foreground">
          <T>
            Reconnect <Var>{scope.label}</Var> to change its settings.
          </T>
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}

function SettingsContentLayout({ children }: { children: ReactNode }) {
  const gt = useGT();
  const isMobile = useMediaQuery("max-md");
  const contentArea = workspaceAreaProps("settings", 1, gt("Settings content"));
  const navPathname = useLayoutPageLocation().pathname;
  const pathname = useRenderedSettingsPathname();
  const { search, environment } = useSettingsScope();
  const contentScopeKey =
    pathname === "/settings/diagnostics" || pathname === "/settings/providers"
      ? environment?.environmentId
      : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);
  return (
    <AppRouteModal label={gt("Settings")} variant="app-panel">
      <div className="relative flex min-h-0 flex-1">
        <SettingsSidebarNav pathname={navPathname} />
        <div
          {...contentArea}
          data-app-modal-pane=""
          className="pane-mobile-chrome flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <header
            data-pane-header=""
            data-chrome-scope={isMobile ? "" : undefined}
            className="flex h-13 shrink-0 items-center gap-3 ps-5 pe-3"
          >
            <SettingsBreadcrumb pathname={pathname} />
            <div className="relative z-20 ms-auto flex shrink-0 items-center gap-1">
              {pathname === "/settings/general" ? (
                <RestoreDeviceDefaultsButton
                  onRestored={() => setRestoreSignal((value) => value + 1)}
                />
              ) : null}
              <AppRouteModalClose />
            </div>
          </header>
          <div
            key={`${contentScopeKey}:${restoreSignal}`}
            className="min-h-0 flex flex-1 flex-col max-md:overflow-hidden"
          >
            <SettingsScopeBoundary pathname={pathname}>{children}</SettingsScopeBoundary>
          </div>
        </div>
      </div>
    </AppRouteModal>
  );
}

function SettingsPage({ children }: { children?: ReactNode }) {
  const content = children === undefined ? <Outlet /> : children;
  const location = useLayoutPageLocation();
  const rawSearch = validateSettingsRouteSearch(location.search);
  const navigate = useNavigate({ from: "/settings" });
  const router = useRouter();
  const pathname = useRenderedSettingsPathname();
  const page = (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={pathname === "/settings/providers" || pathname === "/settings/secrets"}
      deviceOnly={SETTINGS_DEVICE_ONLY_PATHS.has(pathname)}
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          // Read at call time: subscribing would hand every scope consumer a new context value on
          // each click. A pending navigation's target wins over the page still on screen.
          to: router.state.location.pathname,
          search: () => ({
            pane: rawSearch.pane,
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout>{content}</SettingsContentLayout>
    </SettingsScopeProvider>
  );
  return page;
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
    const moved = movedSettingsPath(location.pathname, location.hash);
    if (moved) throw redirect({ to: moved, search: true, hash: true, replace: true });
  },
  component: SettingsPage,
});
