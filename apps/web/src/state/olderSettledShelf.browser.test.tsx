import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useOlderSettledShelf } from "./olderSettledShelf";

const environmentId = EnvironmentId.make("env-a");
const first = ProjectId.make("project-a");
const second = ProjectId.make("project-b");

function Shelf(props: { readonly scopes: ReadonlyArray<OlderSettledScope> }) {
  const shelf = useOlderSettledShelf({ scopes: props.scopes, expanded: true, visibleCount: 0 });
  return (
    <>
      <output>{shelf.pages.get(environmentId) ?? 0}</output>
      <button type="button" onClick={() => shelf.grow(new Map([[environmentId, 1]]))}>
        Grow
      </button>
    </>
  );
}

describe("useOlderSettledShelf", () => {
  it("keeps requested pages when the scope's projects reorder", async () => {
    await using screen = await render(
      <Shelf scopes={[{ environmentId, projectIds: [first, second] }]} />,
      // A bare hook host; nothing here links or navigates.
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Grow" }));
    await expect.element(screen.getByRole("status")).toHaveTextContent("1");

    // Loading a page can reorder the sidebar's projects; the shelf must not drop its pages.
    await screen.rerender(<Shelf scopes={[{ environmentId, projectIds: [second, first] }]} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("1");
  });
});
