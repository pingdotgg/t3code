import { describe, expect, it } from "vite-plus/test";

import { replaceProjectIconSetting } from "./ProjectIconSettings";

describe("replaceProjectIconSetting", () => {
  it("sets and trims a project icon without changing other projects", () => {
    expect(
      replaceProjectIconSetting(
        { "/workspace/one": "/icons/one.svg" },
        "/workspace/two",
        "  ~/icons/two.svg  ",
      ),
    ).toEqual({
      "/workspace/one": "/icons/one.svg",
      "/workspace/two": "~/icons/two.svg",
    });
  });

  it("removes only the selected project when the path is blank", () => {
    expect(
      replaceProjectIconSetting(
        {
          "/workspace/one": "/icons/one.svg",
          "/workspace/two": "/icons/two.svg",
        },
        "/workspace/one",
        " ",
      ),
    ).toEqual({ "/workspace/two": "/icons/two.svg" });
  });
});
