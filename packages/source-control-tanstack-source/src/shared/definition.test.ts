import { describe, expect, it } from "vite-plus/test";

import { definition, parsePullRequestUrl } from "./definition.ts";

describe("TanStack Source definition", () => {
  it("reads pull requests and commits only on its own host", () => {
    expect(
      definition.parseCommitUrl?.(
        new URL(
          "https://source.tanstack.com/@TanStack/router/commit/cebaf84a4fe3776f27359ef1d978f0650d6b0e51",
        ),
      ),
    ).toMatchObject({ repository: "tanstack/router" });
    for (const url of [
      "https://github.com/TanStack/router/pull/1",
      "https://source.tanstack.com.evil.test/@TanStack/router/pull/1",
      "https://source.tanstack.com/@TanStack/router/pull/0",
    ])
      expect(parsePullRequestUrl(url), url).toBeNull();
    // Some clients send the owner's `@` percent-encoded.
    expect(
      definition.parseIssueUrl?.(new URL("https://source.tanstack.com/%40TanStack/ai/issues/12")),
    ).toEqual({ host: "source.tanstack.com", scope: "tanstack/ai", key: "12" });
  });

  it("builds links with the owner's @ and reads src's checkout command", () => {
    expect(
      definition.changeRequestUrl({
        host: "source.tanstack.com",
        repository: "TanStack/router",
        number: 7,
      }),
    ).toBe("https://source.tanstack.com/@TanStack/router/pull/7");
    // A stored link or an older client may name the repository as the web spells it.
    for (const repository of ["@TanStack/router", "%40TanStack/router"])
      expect(
        definition.changeRequestUrl({ host: "source.tanstack.com", repository, number: 7 }),
        repository,
      ).toBe("https://source.tanstack.com/@TanStack/router/pull/7");
    expect(definition.checkoutCommandArgument("src pr checkout 7")).toBe("7");
    expect(definition.checkoutCommandArgument("gh pr checkout 7")).toBeNull();
  });

  it.each(["tanstack/router", "@tanstack/router", "%40tanstack/router"])(
    "keys %s as the API's owner/name",
    (repository) => {
      expect(definition.canonicalRepositoryKey?.(`source.tanstack.com/${repository}`)).toBe(
        "source.tanstack.com/tanstack/router",
      );
      expect(definition.canonicalRepositoryKey?.(`github.com/${repository}`)).toBeNull();
    },
  );
});
