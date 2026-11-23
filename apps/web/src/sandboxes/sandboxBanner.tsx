import { useAtomValue } from "@effect/atom-react";
import { WifiOffIcon } from "lucide-react";
import { Atom } from "effect/reactivity";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { sandboxEnvironment } from "../state/sandboxes";
import { startSandbox } from "./sandboxActions";
import { readSandboxes } from "./useSandboxes";

// A primitive per environment, so the chat only re-renders when the banner changes.
const bannerStateAtom = Atom.family((environmentId: string) =>
  Atom.make((get): `${"stopped" | "starting"}:${string}` | null => {
    const sandbox = get(sandboxEnvironment.sandboxesAtom).find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (sandbox === undefined) return null;
    if (sandbox.action === null && sandbox.phase === "stopped") return `stopped:${sandbox.name}`;
    if (sandbox.action === "starting" || sandbox.phase === "starting") {
      return `starting:${sandbox.name}`;
    }
    return null;
  }).pipe(Atom.withLabel(`sandboxes:banner:${environmentId}`)),
);
const NO_BANNER = Atom.make(null).pipe(Atom.withLabel("sandboxes:banner:none"));

/**
 * The composer's offline banner for a Sandbox environment, in place of the
 * generic one: a stopped Sandbox is not reconnecting, it needs starting.
 */
export function useSandboxBanner(environmentId: string | null): ComposerBannerStackItem | null {
  const state = useAtomValue(environmentId === null ? NO_BANNER : bannerStateAtom(environmentId));
  if (environmentId === null || state === null) return null;
  const separator = state.indexOf(":");
  const kind = state.slice(0, separator);
  const name = state.slice(separator + 1);
  return {
    id: `environment-unavailable:${environmentId}`,
    variant: "warning",
    icon: <WifiOffIcon />,
    title: kind === "stopped" ? `${name} is stopped` : `${name} is starting…`,
    actions:
      kind === "stopped" ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            const sandbox = readSandboxes().find(
              (candidate) => candidate.environmentId === environmentId,
            );
            if (sandbox !== undefined) void startSandbox(sandbox);
          }}
        >
          Start
        </Button>
      ) : undefined,
  };
}
