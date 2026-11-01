import { redactSshAddresses } from "@t3tools/client-runtime/connection";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { redactSshText } from "./sshTarget";

export function SshSensitiveText({
  value,
  destination = value,
  target,
  className,
}: {
  readonly value: string;
  readonly destination?: string;
  readonly target?: DesktopSshEnvironmentTarget | undefined;
  readonly className?: string;
}) {
  return (
    <RedactedSensitiveText
      key={value}
      value={value}
      redactedValue={target ? redactSshAddresses(value, target) : redactSshText(value, destination)}
      ariaLabel="Toggle SSH details visibility"
      revealTooltip="Click to reveal details"
      hideTooltip="Click to hide details"
      {...(className === undefined ? {} : { className })}
    />
  );
}
