import { type EnvironmentId, sessionGrantsScope } from "@t3tools/contracts";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import { useEnvironmentSessionState } from "~/state/session";
import { useT } from "../../hooks/useI18n";

// The shared scope titles are English; map them to message keys here.
const SCOPE_TITLE_KEYS: Record<string, MessageKey> = {
  "View environment": "settings.providers.sessionPermissions.scope.viewEnvironment",
  "Operate tasks": "settings.providers.sessionPermissions.scope.operateTasks",
  "Change environment settings": "settings.providers.sessionPermissions.scope.changeSettings",
  "Manage providers": "settings.providers.sessionPermissions.scope.manageProviders",
  "Maintain environment": "settings.providers.sessionPermissions.scope.maintainEnvironment",
  "Control previews": "settings.providers.sessionPermissions.scope.controlPreviews",
  "View diagnostics and usage": "settings.providers.sessionPermissions.scope.viewDiagnostics",
  "View terminals": "settings.providers.sessionPermissions.scope.viewTerminals",
  "Use terminals": "settings.providers.sessionPermissions.scope.useTerminals",
  "Change source control": "settings.providers.sessionPermissions.scope.changeSourceControl",
  "Read files": "settings.providers.sessionPermissions.scope.readFiles",
  "Write files": "settings.providers.sessionPermissions.scope.writeFiles",
  "View access": "settings.providers.sessionPermissions.scope.viewAccess",
  "Manage access": "settings.providers.sessionPermissions.scope.manageAccess",
  "View relay": "settings.providers.sessionPermissions.scope.viewRelay",
  "Manage relay": "settings.providers.sessionPermissions.scope.manageRelay",
};

export function SessionPermissions({
  environmentId,
  connected,
  routeContext = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly routeContext?: boolean;
}) {
  const t = useT();
  const session = useEnvironmentSessionState(environmentId);
  const unavailableMessage = (input: {
    readonly connected: boolean;
    readonly failed: boolean;
    readonly rejected: boolean;
  }) => {
    if (!input.connected)
      return t("settings.providers.sessionPermissions.unavailable.disconnected");
    if (input.rejected) return t("settings.providers.sessionPermissions.unavailable.rejected");
    return input.failed
      ? t("settings.providers.sessionPermissions.unavailable.failed")
      : t("settings.providers.sessionPermissions.unavailable.checking");
  };
  return connected && !session.hasError && !session.isPending && session.data?.authenticated ? (
    <div className="space-y-3 py-3 text-xs">
      <p className="text-muted-foreground">
        {routeContext
          ? t("settings.providers.sessionPermissions.routeContext")
          : t("settings.providers.sessionPermissions.clientContext")}
      </p>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {AUTH_SCOPE_OPTIONS.map(({ scope, title }) => (
          <li key={scope} className="flex items-start justify-between gap-3">
            <span>{SCOPE_TITLE_KEYS[title] ? t(SCOPE_TITLE_KEYS[title]) : title}</span>
            <span className="shrink-0 text-muted-foreground">
              {sessionGrantsScope(session.data!, scope)
                ? t("settings.providers.sessionPermissions.allowed")
                : t("settings.providers.sessionPermissions.notGranted")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="py-3 text-xs text-muted-foreground">
      {unavailableMessage({
        connected,
        failed: session.hasError,
        rejected: !session.hasError && !session.isPending && session.data?.authenticated === false,
      })}
    </p>
  );
}
