import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { revisionedQuery } from "./revisionedQuery";

describe("revisionedQuery in React", () => {
  it("refetches for a new revision without updating a component during render", async () => {
    let fetches = 0;
    const query = Atom.make(() => {
      fetches += 1;
      return fetches;
    }).pipe(Atom.keepAlive);
    const registry = AtomRegistry.make();
    function Reader({ revision }: { revision: string }) {
      return <span>fetch {useAtomValue(revisionedQuery(query, revision))}</span>;
    }
    const ui = (revision: string) => (
      <RegistryContext.Provider value={registry}>
        <Reader revision={revision} />
      </RegistryContext.Provider>
    );
    using consoleError = vi.spyOn(console, "error");
    // A bare atom reader: no links or navigation to route.
    await using screen = await render(ui("mutation-1"), { router: false });
    await expect.element(screen.getByText("fetch 1")).toBeInTheDocument();

    await screen.rerender(ui("mutation-2"));

    await expect.element(screen.getByText("fetch 2")).toBeInTheDocument();
    expect(consoleError.mock.calls.map(([message]) => String(message))).not.toContainEqual(
      expect.stringContaining("Cannot update a component"),
    );
  });
});
