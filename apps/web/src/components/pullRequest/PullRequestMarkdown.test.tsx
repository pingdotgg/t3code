import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  chatMarkdown: vi.fn(),
}));

vi.mock("../ChatMarkdown", () => ({
  default: (props: unknown) => {
    mocks.chatMarkdown(props);
    return <div />;
  },
}));

import { PullRequestMarkdown, PullRequestThreadRefProvider } from "./PullRequestMarkdown";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_REF = {
  environmentId: ENVIRONMENT_ID,
  threadId: ThreadId.make("thread-1"),
};

describe("pull request markdown", () => {
  beforeEach(() => {
    mocks.chatMarkdown.mockClear();
  });

  it("passes the owning thread to links rendered inside a thread panel", () => {
    renderToStaticMarkup(
      <PullRequestThreadRefProvider threadRef={THREAD_REF} scopeWorkspaceToThread>
        <PullRequestMarkdown
          text="[Related pull request](https://github.com/pingdotgg/t3code/pull/6446)"
          cwd="/workspace"
          environmentId={ENVIRONMENT_ID}
        />
      </PullRequestThreadRefProvider>,
    );

    expect(mocks.chatMarkdown).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        pullRequestLinkThreadRef: THREAD_REF,
        threadRef: THREAD_REF,
      }),
    );
  });

  it("keeps pull request navigation scoped without assigning foreign files to the thread", () => {
    renderToStaticMarkup(
      <PullRequestThreadRefProvider threadRef={THREAD_REF} scopeWorkspaceToThread={false}>
        <PullRequestMarkdown
          text="[Related pull request](https://github.com/pingdotgg/t3code/pull/6446)"
          cwd="/foreign-workspace"
          environmentId={ENVIRONMENT_ID}
        />
      </PullRequestThreadRefProvider>,
    );

    expect(mocks.chatMarkdown).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        pullRequestLinkThreadRef: THREAD_REF,
        threadRef: undefined,
      }),
    );
  });

  it("leaves links unscoped on the pull requests page", () => {
    renderToStaticMarkup(
      <PullRequestMarkdown
        text="[Related pull request](https://github.com/pingdotgg/t3code/pull/6446)"
        cwd="/workspace"
        environmentId={ENVIRONMENT_ID}
      />,
    );

    expect(mocks.chatMarkdown).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        pullRequestLinkThreadRef: undefined,
        threadRef: undefined,
      }),
    );
  });
});
