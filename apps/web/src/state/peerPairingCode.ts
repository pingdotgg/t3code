import { mintPeerPairingCode } from "@t3tools/client-runtime/state/peerPairingCode";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

// Each read mints a new one-use code; nothing keeps one once it is read.
const peerPairingCodeAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return mintPeerPairingCode(prepared);
    })
    .pipe(Atom.withLabel(`peer-pairing-code:${environmentId}`)),
);

/**
 * A fresh pairing code minted on `environmentId` with this client's session
 * there, for answering a link request. Fails with `PeerPairingCodeError` when
 * the session may not create one.
 */
export function mintPairingCodeOn(environmentId: EnvironmentId): Promise<string> {
  const atom = peerPairingCodeAtom(environmentId);
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* AtomRegistry.mount(appAtomRegistry, atom);
        return yield* AtomRegistry.getResult(appAtomRegistry, atom, {
          suspendOnWaiting: true,
        }).pipe(Effect.timeout("15 seconds"));
      }),
    ),
  );
}
