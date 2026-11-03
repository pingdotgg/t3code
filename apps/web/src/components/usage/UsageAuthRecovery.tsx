import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { AuthProvidersManageScope, type EnvironmentId, type UsageSource } from "@t3tools/contracts";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { InlineButton } from "../ui/button";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export function UsageAuthRecovery({
  environmentId,
  label,
  source,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly source: UsageSource;
}) {
  const navigate = useNavigate();
  const permitted = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  return source.authRecovery?.map((target) => {
    const instanceId = target.kind === "cursorCli" ? undefined : target.instanceId;
    const provider = providers?.find((provider) => provider.instanceId === instanceId);
    const name = provider?.displayName ?? PROVIDER_PRESENTATION[source.fingerprint.provider].label;
    return (
      <div
        key={instanceId ?? "cli"}
        className="mb-4 flex flex-wrap items-baseline gap-2 text-sm text-muted-foreground"
      >
        <span>
          {label} · {name}: {source.message ?? "Sign-in needs attention."}
        </span>
        {target.kind === "cursorCli" ? (
          <>
            <span>
              Run <code>cursor-agent login</code> on {label}, then refresh Usage.
            </span>
            <InlineButton
              disabled={!permitted}
              onClick={() =>
                void writeTextToClipboard("cursor-agent login", "Cursor sign-in command")
              }
            >
              Copy sign-in command
            </InlineButton>
          </>
        ) : (
          <>
            {target.kind === "apiKey" ? (
              <span>Update CURSOR_API_KEY in this provider's settings.</span>
            ) : null}
            <InlineButton
              disabled={!permitted}
              onClick={() =>
                void navigate({
                  to: "/settings/providers",
                  search: { environmentId, instanceId: target.instanceId },
                })
              }
            >
              {target.kind === "apiKey" ? "Provider settings" : "Sign in again"}
            </InlineButton>
          </>
        )}
      </div>
    );
  });
}
