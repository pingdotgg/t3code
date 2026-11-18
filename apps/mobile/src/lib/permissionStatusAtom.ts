import { Atom } from "effect/reactivity";

import { subscribeAppActive } from "./appState";

/**
 * A system permission or device capability as the app last saw it. Reads it
 * when first mounted and again each time the app returns to the foreground,
 * where the user may have changed it in system Settings. Writing stores the outcome of a request.
 */
export function makePermissionStatusAtom<S>(options: {
  readonly label: string;
  readonly initial: S;
  readonly read: () => Promise<S>;
}): Atom.Writable<S, S> {
  return Atom.writable(
    (get) => {
      // A read that settles after unmount is dropped: setSelf on a disposed lifetime is a no-op.
      // Only the latest read lands, so a slow earlier read cannot overwrite a newer status.
      let latest = 0;
      const refresh = () => {
        const read = ++latest;
        void options.read().then((status) => {
          if (read === latest) get.setSelf(status);
        });
      };
      refresh();
      get.addFinalizer(subscribeAppActive(refresh));
      return options.initial;
    },
    (ctx, status: S) => ctx.setSelf(status),
  ).pipe(Atom.withLabel(options.label));
}
