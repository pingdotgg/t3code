import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "../state/presentation";
import { sandboxEnvironment } from "../state/sandboxes";
import { sandboxesOnSeveralHostsAtom } from "./useSandboxes";

// The host of a Sandbox environment, once the client has Sandboxes on more than one host, since
// each can have a Sandbox of the same name. One small atom per row keeps the sidebar cheap.
const sandboxHostLabelAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): string | null => {
    if (!get(sandboxesOnSeveralHostsAtom)) return null;
    const sandbox = get(sandboxEnvironment.sandboxesAtom).find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (sandbox === undefined) return null;
    return (
      get(environmentPresentations.presentationsAtom).get(sandbox.hostEnvironmentId)?.entry.target
        .label ?? null
    );
  }).pipe(Atom.withLabel(`sandboxes:host-label:${environmentId}`)),
);

/** " · desktop" after a Sandbox thread's project, when Sandboxes on two hosts could share a name. */
export function SandboxHostSuffix({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const host = useAtomValue(sandboxHostLabelAtom(environmentId));
  return host === null ? null : <span className="text-muted-foreground/70"> · {host}</span>;
}

/** "on desktop" under a Sandbox project's name in a list, when Sandboxes on two hosts could share it. */
export function SandboxHostLine({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const host = useAtomValue(sandboxHostLabelAtom(environmentId));
  return host === null ? null : (
    <span className="block truncate text-muted-foreground text-xs">on {host}</span>
  );
}
