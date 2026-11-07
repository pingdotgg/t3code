import { expect, it } from "vite-plus/test";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { linkedPrBarConfirm, shortGitBarLabel } from "./threadGitBarPrimary";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";

const changeRequest = sourceControlClients.get(undefined).changeRequest;

function pr(
  input: Partial<ThreadPrPresentation> & Pick<ThreadPrPresentation, "number">,
): ThreadPrPresentation {
  return {
    kind: "pull-request",
    others: 0,
    state: "open",
    isDraft: false,
    updatedAt: null,
    url: `https://github.com/pingdotgg/t3code/pull/${input.number}`,
    changeRequest,
    label: String(input.number),
    accessibilityLabel: `#${input.number}`,
    textClassName: "text-adaptive-emerald-600-400",
    ...input,
  };
}

it("linkedPrBarConfirm shows the PR number for a single link", () => {
  expect(linkedPrBarConfirm(pr({ number: 32394 }))).toEqual({
    label: "#32394",
    icon: undefined,
    showLabel: true,
    accessibilityLabel: "#32394",
  });
});

it("linkedPrBarConfirm shows a glyph and count when several are linked", () => {
  expect(
    linkedPrBarConfirm(
      pr({
        number: 12,
        others: 2,
        label: "+3",
        accessibilityLabel: "3 linked pull requests, overall open",
      }),
    ),
  ).toEqual({
    label: "+3",
    showLabel: true,
    accessibilityLabel: "3 linked pull requests, overall open",
  });
});

it("linkedPrBarConfirm uses the stack depth label for stacked PRs", () => {
  expect(
    linkedPrBarConfirm(
      pr({
        number: 12,
        kind: "stack",
        label: "3",
        accessibilityLabel: "3 pull requests in stack, open",
      }),
    ),
  ).toMatchObject({
    label: "3",
    showLabel: true,
  });
});

it("shortGitBarLabel uses the open PR number instead of View", () => {
  expect(
    shortGitBarLabel({ kind: "open_pr", label: "View PR", disabled: false }, "PR", 32394),
  ).toEqual({ label: "#32394", disabled: false });
});
