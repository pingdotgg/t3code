import type { DesktopBridge, DesktopCliCommandState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

type DesktopCliCommandBridge = NonNullable<DesktopBridge["cliCommand"]>;

class DesktopCliCommandUnavailableError extends Schema.TaggedError<DesktopCliCommandUnavailableError>()(
  "DesktopCliCommandUnavailableError",
  {},
) {
  override get message(): string {
    return "The t3 command is unavailable.";
  }
}

class DesktopCliCommandLoadError extends Schema.TaggedError<DesktopCliCommandLoadError>()(
  "DesktopCliCommandLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load the t3 command state.";
  }
}

export function getDesktopCliCommandBridge(): DesktopCliCommandBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.cliCommand;
}

const loadDesktopCliCommandState = Effect.fn("loadDesktopCliCommandState")(function* () {
  const bridge = getDesktopCliCommandBridge();
  if (!bridge) {
    return yield* new DesktopCliCommandUnavailableError();
  }
  return yield* Effect.tryPromise({
    try: (): Promise<DesktopCliCommandState> => bridge.getState(),
    catch: (cause) => new DesktopCliCommandLoadError({ cause }),
  });
});

export const desktopCliCommandStateAtom = Atom.make(loadDesktopCliCommandState()).pipe(
  // Keep the loaded state, but let the SWR wrapper revalidate when Settings remounts.
  Atom.keepAlive,
  Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
  Atom.withLabel("desktop:cli-command:load"),
);

export function refreshDesktopCliCommandState(): void {
  appAtomRegistry.refresh(desktopCliCommandStateAtom);
}
