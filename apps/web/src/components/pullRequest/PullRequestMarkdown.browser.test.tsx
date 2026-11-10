import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { type AssetResource, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";

const requested = vi.hoisted(() => [] as Array<AssetResource | null>);
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (_environmentId, resource) => {
    requested.push(resource);
    return { _tag: "Loading" };
  },
}));

function setup() {
  requested.length = 0;
}

async function renderBody(
  host: string,
  options: { lineBreaks?: boolean; repository?: string; text?: string } = {},
) {
  const { repository = null, text = "first line\nsecond line", ...props } = options;
  const context = {
    remarkPlugins: [],
    lineBreaks: sourceControlClients.get(host).hardLineBreaks ?? false,
    threadRef: null,
    repository,
    host: null,
  };
  return render(
    <PullRequestMarkdownContext value={context}>
      <PullRequestMarkdown
        text={text}
        cwd="/repo"
        environmentId={EnvironmentId.make("local")}
        {...props}
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

it("loads the body's host media in the pull request's repository, not the checkout's", async () => {
  setup();
  const image = "https://github.com/user-attachments/assets/7195f963-51a9-4331-be74-3e06be760422";
  const video = "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456";
  await using _screen = await renderBody("github", {
    repository: "enterprise/private",
    text: `![shot](${image})\n\n${video}`,
  });
  await vi.waitFor(() =>
    expect(requested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cwd: "/repo",
          url: expect.stringContaining("7195f963"),
          repository: "enterprise/private",
        }),
        expect.objectContaining({
          cwd: "/repo",
          url: expect.stringContaining("2f8c1a90"),
          repository: "enterprise/private",
        }),
      ]),
    ),
  );
});
