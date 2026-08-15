import { assert, describe, it } from "vite-plus/test";

import { hiddenToastActionProps, stackedThreadToast } from "./toastHelpers";

describe("hiddenToastActionProps", () => {
  it("is a defined update payload so Base UI can replace a previous action", () => {
    assert.equal(hiddenToastActionProps.children, null);
    assert.equal(
      "actionProps" in stackedThreadToast({ type: "loading", title: "Updating" }),
      false,
    );
    assert.deepEqual(
      stackedThreadToast({
        type: "loading",
        title: "Updating",
        actionProps: hiddenToastActionProps,
      }).actionProps,
      hiddenToastActionProps,
    );
  });
});
