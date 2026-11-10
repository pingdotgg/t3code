import { DesktopAppActivationCoordinator } from "./DesktopAppActivationCoordinator";
import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";
import { RunningThreadKeepAlive } from "./RunningThreadKeepAlive";
import { SnapShotCoordinator } from "./SnapShotCoordinator";
import { SshPasswordPromptDialog } from "./SshPasswordPromptDialog";

export default function DesktopCoordinators({
  authenticated,
  localEnvironmentDisabled,
}: {
  readonly authenticated: boolean;
  readonly localEnvironmentDisabled: boolean;
}) {
  return (
    <>
      {authenticated ? <DesktopAppActivationCoordinator /> : null}
      {authenticated || localEnvironmentDisabled ? <DesktopWebLinkCoordinator /> : null}
      <RunningThreadKeepAlive />
      <SshPasswordPromptDialog />
      <SnapShotCoordinator />
    </>
  );
}
