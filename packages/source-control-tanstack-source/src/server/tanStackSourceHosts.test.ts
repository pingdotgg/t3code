import { describe, expect, it } from "vite-plus/test";

import { tanStackSourceRepositoryPath } from "./tanStackSourceHosts.ts";

describe("tanStackSourceRepositoryPath", () => {
  it.each([
    ["acme/web", "acme/web"],
    ["@acme/web", "acme/web"],
    // Clients without this host's definition percent-encode the owner's `@`.
    ["%40acme/web", "acme/web"],
    ["/@acme/web.git/", "acme/web"],
    ["acme/web.private", "acme/web.private"],
    ["acme", null],
    ["acme/web/extra", null],
    ["acme/..", null],
  ])("reads %s as %s", (path, repository) => {
    expect(tanStackSourceRepositoryPath(path)).toBe(repository);
  });
});
