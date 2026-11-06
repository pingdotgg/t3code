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

vi.mock(import("~/hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), mathRenderingEnabled: true };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

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

it("keeps forge backslash escapes as literal text when math rendering is on", async () => {
  await using screen = await renderBody("github", {
    text: "- [CGY-47901](https://x) - \\[Endpoint MFE\\] Language dropdown missing _(New)_\n- \\(foo bar\\)",
  });
  await expect.element(screen.getByText(/Language dropdown missing/)).toBeInTheDocument();
  const math = [...screen.container.querySelectorAll("[data-markdown-math]")];
  expect(math.map((node) => node.getAttribute("data-markdown-math"))).toEqual([]);
  expect(screen.container.textContent).toContain("[Endpoint MFE] Language dropdown missing");
  expect(screen.container.textContent).toContain("(foo bar)");
});
