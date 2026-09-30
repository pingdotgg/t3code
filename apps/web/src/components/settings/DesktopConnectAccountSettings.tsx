import { CloudIcon } from "lucide-react";
import { EnvironmentId } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import {
  refreshDesktopConnectAccount,
  signInDesktopConnectAccount,
  signOutDesktopConnectAccount,
  useDesktopConnectAccount,
} from "../../environments/runtime/desktopAccount";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime/catalog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DesktopConnectAccountSettings() {
  const { account, busy, error } = useDesktopConnectAccount();
  const runtime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const primaryId = usePrimaryEnvironmentId();
  if (!window.desktopBridge?.connectAccount) return null;

  return (
    <SettingsSection
      title="Your T3 Connect devices"
      description="Sign in once to use your linked machines from this desktop app. Choose a device in Run on or Add Project."
      icon={<CloudIcon aria-hidden className="size-3" />}
    >
      <SettingsRow
        title={account ? account.identity : "Sign in to T3 Connect"}
        description="This desktop sign-in is separate from hosting this machine. Signing out does not unlink or stop your hosts."
      >
        <div className="flex flex-wrap gap-2">
          {account ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void refreshDesktopConnectAccount()}
              >
                Refresh devices
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void signOutDesktopConnectAccount()}
              >
                Sign out
              </Button>
            </>
          ) : busy ? (
            <Button variant="outline" size="sm" onClick={() => void signOutDesktopConnectAccount()}>
              Cancel sign-in
            </Button>
          ) : (
            <Button size="sm" onClick={() => void signInDesktopConnectAccount()}>
              Sign in
            </Button>
          )}
        </div>
      </SettingsRow>
      {error ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {account?.environments.map((environment) => (
        <SettingsRow
          key={environment.environmentId}
          title={environment.label}
          description={environment.environmentId}
        >
          <Badge variant="secondary" size="sm">
            {environment.environmentId === primaryId
              ? "This machine"
              : runtime[EnvironmentId.make(environment.environmentId)]?.connectionState ===
                  "connected"
                ? "Connected"
                : runtime[EnvironmentId.make(environment.environmentId)]?.connectionState ===
                    "error"
                  ? "Unavailable"
                  : "Connecting"}
          </Badge>
        </SettingsRow>
      ))}
      {account && account.environments.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No linked machines yet. Run <code>t3 connect</code> on a machine to make it available
          here.
        </p>
      ) : null}
    </SettingsSection>
  );
}
