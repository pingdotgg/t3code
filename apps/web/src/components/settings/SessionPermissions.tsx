import { type EnvironmentId, sessionGrantsScope } from "@t3tools/contracts";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import { useEnvironmentSessionState } from "~/state/session";
import { FoldedSettingsSection } from "./FoldedSettingsSection";

export function SessionPermissions({
  environmentId,
  label,
  connected,
  routeContext = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly routeContext?: boolean;
}) {
  const session = useEnvironmentSessionState(environmentId);
  return (
    <FoldedSettingsSection
      id={`session-permissions-${environmentId}`}
      title="Your permissions"
      summary={label}
    >
      {connected && !session.hasError && !session.isPending && session.data?.authenticated ? (
        <div className="space-y-3 px-4 py-3 text-xs">
          <p className="text-muted-foreground">
            {routeContext
              ? "Applies to the route marked In use. Other routes may have different permissions and have not been checked."
              : "These permissions apply to this client’s current connection."}
          </p>
          <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {AUTH_SCOPE_OPTIONS.map(({ scope, title }) => (
              <li key={scope} className="flex items-start justify-between gap-3">
                <span>{title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {sessionGrantsScope(session.data!, scope) ? "Allowed" : "Not granted"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Permissions not checked. Connect to this environment to view this session’s permissions.
        </p>
      )}
    </FoldedSettingsSection>
  );
}
