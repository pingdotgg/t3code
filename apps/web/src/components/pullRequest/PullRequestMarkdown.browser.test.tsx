import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";

async function renderBody(host: string, options: { lineBreaks?: boolean } = {}) {
  const context = {
    remarkPlugins: [],
    lineBreaks: sourceControlClients.get(host).hardLineBreaks ?? false,
    threadRef: null,
  };
  return render(
    <PullRequestMarkdownContext value={context}>
      <PullRequestMarkdown
        text={"first line\nsecond line"}
        cwd="/repo"
        environmentId={EnvironmentId.make("local")}
        {...options}
      />
    </PullRequestMarkdownContext>,
  );
}

it.each(["github", "forgejo", "azure-devops"])("%s breaks a single newline", async (host) => {
  await using screen = await renderBody(host);
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(1);
});

it.each(["gitlab", "bitbucket", "gitcafe", "unknown"])(
  "%s joins a single newline",
  async (host) => {
    await using screen = await renderBody(host);
    await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
    expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
  },
);

it("lets text the host did not write opt out of the host's breaks", async () => {
  await using screen = await renderBody("github", { lineBreaks: false });
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
});
