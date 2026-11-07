import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

vi.mock("../../state/entities", () => ({
  useThreadShell: () => null,
  useThreadRefs: () => [],
  useProject: () => null,
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

import { MarkdownThreadLink } from "./MarkdownThreadLink";

it("opens a scoped thread missing from the shell instead of disabling its link", async () => {
  const environmentId = EnvironmentId.make("archbook");
  const threadId = ThreadId.make("omitted-child");
  await using screen = await render(
    <MarkdownThreadLink
      environmentId={EnvironmentId.make("another-environment")}
      link={{ environmentId, threadId }}
      label={null}
    />,
  );
  const link = screen.getByRole("link", { name: "Thread, Thread", exact: true });
  await link.click();
  await vi.waitFor(() => {
    expect(screen.router?.latestLocation.pathname).toBe(`/${environmentId}/${threadId}`);
  });
});
