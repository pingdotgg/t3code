import { Atom } from "effect/reactivity";

export function workingUsageQuery<A>(
  query: Atom.Atom<A>,
  working: Atom.Atom<boolean>,
): Atom.Atom<A> {
  return Atom.make((get) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = (running: boolean) => {
      clearInterval(timer);
      timer = running ? setInterval(() => get.refresh(query), 60_000) : undefined;
    };
    update(get.once(working));
    get.subscribe(working, (running) => {
      update(running);
      // Capture the beginning and final totals, without polling stopped sessions.
      get.refresh(query);
    });
    get.subscribe(query, (value) => get.setSelf(value));
    get.addFinalizer(() => clearInterval(timer));
    return get.once(query);
  });
}
