import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { Button } from "../components/ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../components/ui/menu";
import { useSandboxHostOptions, type SandboxHostOption } from "./useSandboxes";

function HostIcon({ option }: { readonly option: SandboxHostOption }) {
  return <EnvironmentMachineIcon aria-hidden kind={option.machine} className="size-3.5 shrink-0" />;
}

/**
 * The machine whose Sandboxes a view shows, picked as Settings picks the machine it applies to.
 * With one host there is nothing to pick, so it only names it.
 */
export function SandboxHostMenu({
  value,
  onChange,
}: {
  readonly value: EnvironmentId;
  readonly onChange: (hostEnvironmentId: EnvironmentId) => void;
}) {
  const options = useSandboxHostOptions();
  const selected = options.find((option) => option.hostEnvironmentId === value);
  // A host that went away while selected leaves the menu, so another can be picked.
  if (selected === undefined && options.length === 0) return null;
  if (selected !== undefined && options.length < 2) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
        <HostIcon option={selected} />
        <span className="truncate">{selected.label}</span>
      </span>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Sandbox host: ${selected?.label ?? "Unavailable host"}`}
        render={<Button variant="outline" size="sm" />}
        className="min-w-0 max-w-72"
      >
        {selected ? <HostIcon option={selected} /> : null}
        <span className="min-w-0 truncate">{selected?.label ?? "Unavailable host"}</span>
        <ChevronDownIcon
          aria-hidden
          strokeWidth={1.75}
          className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              const option = options.find((candidate) => candidate.hostEnvironmentId === next);
              if (option) onChange(option.hostEnvironmentId);
            }}
          >
            {options.map((option) => (
              <MenuRadioItem
                key={option.hostEnvironmentId}
                value={option.hostEnvironmentId}
                closeOnClick
              >
                <span className="flex min-w-0 items-center gap-2">
                  <HostIcon option={option} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {option.summary}
                    </span>
                  </span>
                  {option.offline ? (
                    <span className="shrink-0 text-muted-foreground text-xs">Offline</span>
                  ) : null}
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}
