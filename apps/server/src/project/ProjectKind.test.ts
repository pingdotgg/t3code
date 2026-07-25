import { assert, it } from "@effect/vitest";

import { resolveProjectKind } from "./ProjectKind.ts";

it("marks projects rooted at the chats dir as chats", () => {
  assert.equal(resolveProjectKind("/home/user/.t3/chats", "/home/user/.t3/chats"), "chats");
});

it("keeps other projects standard", () => {
  assert.equal(resolveProjectKind("/home/user/dev/app", "/home/user/.t3/chats"), "standard");
  assert.equal(resolveProjectKind("/home/user/dev/chats", "/home/user/.t3/chats"), "standard");
});

it("treats a missing chats dir as standard", () => {
  assert.equal(resolveProjectKind("/home/user/.t3/chats", undefined), "standard");
});
