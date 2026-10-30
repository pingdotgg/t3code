import { USAGE_CREDIT_VENDOR_ICONS, usageCreditVendor } from "@t3tools/shared/usageCreditIcons";
import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";

import { cn } from "~/lib/utils";
import { ProviderPackageIcon } from "../chat/ProviderPackageIcon";

/** Brand glyph for a credit balance card; unknown vendors get an initials badge. */
export function CreditVendorIcon({
  balance,
  className,
}: {
  readonly balance: {
    readonly id: string;
    readonly label: string;
    readonly icon?: string | undefined;
  };
  readonly className?: string;
}) {
  const vendor = usageCreditVendor(balance);
  if (vendor) {
    return (
      <ProviderPackageIcon
        icon={USAGE_CREDIT_VENDOR_ICONS[vendor]}
        className={cn("size-4 shrink-0 text-foreground/80", className)}
        aria-hidden
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-4xs font-semibold leading-none text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      {providerInstanceInitials(balance.label)}
    </span>
  );
}
