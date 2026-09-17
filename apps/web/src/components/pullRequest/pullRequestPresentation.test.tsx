import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { PullRequestActorAvatar } from "./pullRequestPresentation";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("falls back to the actor initial when a remote avatar fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <PullRequestActorAvatar
        actor={{ login: "octocat", name: null, avatarUrl: "https://ghe.example/octocat.png" }}
      />,
    );
  });

  await act(async () => renderer!.root.findByType("img").props.onError());

  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  expect(renderer!.root.findByType("span").children).toEqual(["O"]);
});
