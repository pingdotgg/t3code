import { CheckIcon, ChevronsLeftRightEllipsisIcon, TerminalIcon } from "lucide-react";
import type { CloudSandboxDriverKind } from "@t3tools/contracts";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup } from "../ui/radio-group";
import { BoatIcon, type Icon } from "../Icons";
import { OptionListDivider, OptionRowGrid } from "./OptionRowGrid";
import type { EnvironmentType } from "./AddEnvironmentDialog.logic";

export interface CloudSandboxDriverOption {
  readonly driverKind: CloudSandboxDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

const BOAT_DRIVER: CloudSandboxDriverOption = {
  driverKind: "boat",
  label: "boat.dev",
  icon: BoatIcon,
};

/** Offered on the type step beside the direct connections. */
const FEATURED_CLOUD_SANDBOX_DRIVERS: ReadonlyArray<CloudSandboxDriverOption> = [BOAT_DRIVER];

export function EnvironmentTypeGrid({
  value,
  cloudDriver,
  onValueChange,
  disabled,
  desktopBridgeAvailable,
  cloudSandboxAvailable,
  ...labelProps
}: {
  readonly value: EnvironmentType;
  /** The selected cloud provider while `value` is "cloudSandbox". */
  readonly cloudDriver: CloudSandboxDriverKind | null;
  readonly onValueChange: (value: EnvironmentType, cloudDriver?: CloudSandboxDriverKind) => void;
  readonly disabled: boolean;
  readonly desktopBridgeAvailable: boolean;
  /** Profiles live on the connected primary server, so a cloud sandbox needs one. */
  readonly cloudSandboxAvailable: boolean;
  readonly "aria-labelledby"?: string;
}) {
  const remoteSshOptions = [
    {
      id: "remote",
      label: "Remote link",
      description: "Connect with a pairing code or address.",
      icon: ChevronsLeftRightEllipsisIcon,
    },
    ...(desktopBridgeAvailable
      ? ([
          {
            id: "ssh",
            label: "SSH host",
            description: "Connect to a machine over SSH.",
            icon: TerminalIcon,
          },
        ] as const)
      : []),
  ];

  const cloudDriverItems = (drivers: ReadonlyArray<CloudSandboxDriverOption>) =>
    drivers.map((driver) => ({
      id: driver.driverKind,
      label: driver.label,
      icon: <driver.icon className="size-4 shrink-0" />,
    }));

  return (
    <>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          if (next === "remote" || next === "ssh") onValueChange(next);
        }}
        disabled={disabled}
        {...labelProps}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {remoteSshOptions.map((option) => (
            <RadioPrimitive.Root
              key={option.id}
              value={option.id}
              aria-label={option.label}
              className="relative flex cursor-pointer flex-col gap-2 rounded-lg bg-card p-4 text-left text-muted-foreground outline-none ring-1 ring-black/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary dark:ring-white/5"
            >
              <div className="flex items-center justify-between">
                <option.icon className="size-5" />
                <RadioPrimitive.Indicator className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
                  <CheckIcon className="size-3.5" />
                </RadioPrimitive.Indicator>
              </div>
              <span className="text-sm font-medium text-foreground">{option.label}</span>
              <p className="text-xs">{option.description}</p>
            </RadioPrimitive.Root>
          ))}
        </div>
      </RadioGroup>

      {cloudSandboxAvailable ? (
        <div className="grid gap-3 pt-3">
          <OptionListDivider>Or use a cloud sandbox</OptionListDivider>
          <OptionRowGrid
            aria-label="Cloud sandbox providers"
            items={cloudDriverItems(FEATURED_CLOUD_SANDBOX_DRIVERS)}
            value={value === "cloudSandbox" ? cloudDriver : null}
            disabled={disabled}
            onValueChange={(driver) =>
              onValueChange("cloudSandbox", driver as CloudSandboxDriverKind)
            }
          />
        </div>
      ) : null}
    </>
  );
}
