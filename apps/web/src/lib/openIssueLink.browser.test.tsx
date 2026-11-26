import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const project = {
  id: ProjectId.make("project"),
  environmentId,
  workspaceRoot: "/repo",
  repositoryIdentity: {
    provider: "github",
    canonicalKey: "github.com/acme/web",
    displayName: "acme/web",
    owner: "acme",
    name: "web",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
  },
};

vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [project],
  useServerConfigs: () =>
    new Map([[environmentId, { environment: { capabilities: { issues: true } } }]]),
}));

import { __setClientSettingsForTests } from "../hooks/useSettings";
import { useRightPanelStore } from "../rightPanelStore";
import { useOpenIssueLink } from "./openIssueLink";

const issueUrl = "https://github.com/acme/web/issues/42";

function IssueLink({ onResult }: { readonly onResult: (opened: boolean) => void }) {
  const open = useOpenIssueLink(threadRef);
  return (
    <a href={issueUrl} onClick={(event) => onResult(open(event, issueUrl))}>
      Issue 42
    </a>
  );
}

it.each([false, true])(
  "respects issueLinksOpenInApp=%s when clicking an issue link",
  async (issueLinksOpenInApp) => {
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      issueLinksOpenInApp,
    });

    const results: boolean[] = [];
    await using screen = await render(<IssueLink onResult={(opened) => results.push(opened)} />);
    const defaults: boolean[] = [];
    screen.container.addEventListener("click", (nativeEvent) => {
      defaults.push(nativeEvent.defaultPrevented);
      nativeEvent.preventDefault();
    });

    await act(() =>
      screen
        .getByRole("link", { name: "Issue 42" })
        .element()
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
    );

    expect(results).toEqual([issueLinksOpenInApp]);
    expect(defaults).toEqual([issueLinksOpenInApp]);
    if (issueLinksOpenInApp) {
      expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toBeDefined();
    } else {
      expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    }
  },
);
