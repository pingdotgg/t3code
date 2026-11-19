import type { EnvironmentId } from "@t3tools/contracts";
import { mobileAccessEnvironment } from "../../state/mobileAccess";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function MobileConnectionAttempts({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const status = useEnvironmentQuery(
    environmentId === null ? null : mobileAccessEnvironment.status({ environmentId, input: {} }),
  );
  const data = status.data;
  const attempts = new Map(data?.attempts.map((attempt) => [JSON.stringify(attempt), attempt]));
  return (
    <SettingsSection
      id="mobile-connection-attempts"
      title="Mobile connections"
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={environmentId === null || status.isPending}
          onClick={status.refresh}
        >
          Refresh
        </Button>
      }
    >
      <SettingsRow
        title="Compatibility"
        description={
          data ? `Server protocol ${data.serverProtocol}` : "Select an environment above."
        }
      >
        {data?.verifiedClients.length ? (
          <ul className="space-y-1">
            {data.verifiedClients.map((client) => (
              <li key={client}>{client}</li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Recent rejected connections"
        description={
          status.error ??
          (data?.attempts.length === 0 ? "No rejected mobile connections recorded." : undefined)
        }
      >
        <ul className="space-y-3">
          {Array.from(attempts, ([key, attempt]) => (
            <li key={key}>
              <div className="text-xs text-muted-foreground">
                <time dateTime={attempt.at}>{new Date(attempt.at).toLocaleString()}</time>
                {attempt.os ? ` · ${attempt.os}` : ""}
                {attempt.appVersion ? ` · ${attempt.appVersion}` : ""}
              </div>
              <p>{attempt.explanation}</p>
            </li>
          ))}
        </ul>
      </SettingsRow>
    </SettingsSection>
  );
}
