import { ConnectOnboardingDialog } from "./cloud/ConnectOnboardingDialog";
import { RelayClientInstallDialog } from "./cloud/RelayClientInstallDialog";
import { SshPasswordPromptDialog } from "./desktop/SshPasswordPromptDialog";
import { SlowRpcRequestToastCoordinator } from "./SlowRpcRequestToastCoordinator";

export default function AppOverlays() {
  return (
    <>
      <RelayClientInstallDialog />
      <ConnectOnboardingDialog />
      <SshPasswordPromptDialog />
      <SlowRpcRequestToastCoordinator />
    </>
  );
}
