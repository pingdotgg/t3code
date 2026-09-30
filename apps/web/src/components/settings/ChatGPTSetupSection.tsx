import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function ChatGPTSetupSection({
  environmentId,
  instanceId,
  enabled,
  readOnly,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  enabled: boolean;
  readOnly: boolean;
}) {
  const target = { environmentId, input: { instanceId } };
  const auth = useEnvironmentQuery(serverEnvironment.providerAuthState(target)).data;
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, options);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = auth && ["starting", "waiting", "verifying"].includes(auth.phase);
  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    setPending(true);
    setError(null);
    try {
      const result = await command();
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="ChatGPT Web sign-in">
      <SettingsRow
        title="ChatGPT account"
        description="Sign in in Firefox on this environment’s desktop. After login, Firefox switches to background mode when enabled below."
        control={
          <div className="flex flex-wrap gap-2">
            {active && auth.flowId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || readOnly}
                onClick={() =>
                  void run(() =>
                    cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } }),
                  )
                }
              >
                Cancel sign-in
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || readOnly || !enabled || !auth}
                onClick={() => void run(() => start(target))}
              >
                Sign in with Firefox
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || readOnly || !enabled || !auth}
              onClick={() => void run(() => logout(target))}
            >
              Sign out
            </Button>
          </div>
        }
      >
        <p role="status">{error ?? auth?.message ?? "Enable this provider to sign in."}</p>
      </SettingsRow>
    </section>
  );
}
