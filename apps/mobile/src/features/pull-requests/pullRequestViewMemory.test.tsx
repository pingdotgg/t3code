import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";

import { rememberPullRequestView, useEntryPullRequestPath } from "./pullRequestViewMemory";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe(props: { readonly scope: string }) {
    return <span>{useEntryPullRequestPath(props.scope)}</span>;
  }
  return {
    render(scope: string) {
      act(() => root.render(<Probe scope={scope} />));
    },
    get path() {
      return container.textContent;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("keeps the entry path while scrolling remembers later files, and rereads it for another pull request", () => {
  using screen = setup();
  rememberPullRequestView("entry-path:a", { path: "src/first.ts" });
  rememberPullRequestView("entry-path:b", { path: "src/other.ts" });
  screen.render("entry-path:a");

  rememberPullRequestView("entry-path:a", { path: "src/second.ts" });
  screen.render("entry-path:a");
  expect(screen.path).toBe("src/first.ts");

  screen.render("entry-path:b");
  expect(screen.path).toBe("src/other.ts");
});
