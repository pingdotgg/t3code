import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as model from "./viewModel.ts";

NodeTest.test("publish only offers discovered providers that native considers ready", () => {
  NodeAssert.equal(typeof model.readyPublishProviders, "function");
  const providers = [
    { kind: "github", ready: true, account: "alex" },
    { kind: "gitlab", ready: false, account: null },
    { kind: "forgejo", ready: true, account: null },
    { kind: "unknown", ready: true, account: null },
  ];
  NodeAssert.deepEqual(
    model.readyPublishProviders(providers).map((item) => item.kind),
    ["github", "forgejo"],
  );
  NodeAssert.deepEqual(model.readyPublishProviders([]), []);
});
