import { expect, test } from "bun:test";
import groups from "../src/pkjs/groups.js";

const thread = (threadId: string, directory: string, extra: Record<string, unknown> = {}) => ({
  threadId,
  title: threadId,
  directory,
  ...extra,
});

test("groups distinct threads by project directory in first-occurrence order", () => {
  const sections = groups([
    thread("1", "/code/alpha/"),
    thread("2", "/code/beta"),
    thread("3", "/code/alpha"),
    thread("4", "__proto__"),
  ]);
  expect(sections.map((section) => section.title)).toEqual(["alpha", "beta", "__proto__"]);
  expect(sections[0].threads.map((item) => item.threadId)).toEqual(["1", "3"]);
  expect(sections[1].threads.map((item) => item.threadId)).toEqual(["2"]);
  expect(sections[2].threads.map((item) => item.threadId)).toEqual(["4"]);
});

test("omits subagent threads and side chats but keeps forks and threads that share a title", () => {
  const sections = groups([
    thread("1", "/code/alpha", { title: "Fix" }),
    thread("2", "/code/alpha", { title: "Fix" }),
    thread("3", "/code/alpha", {
      title: "Child",
      parentThreadId: "1",
      relationshipToParent: "subagent",
    }),
    thread("4", "/code/beta", { parentThreadId: "1", relationshipToParent: "fork" }),
    thread("5", "/code/alpha", { title: "Side chat", sideChat: true }),
    thread("6", "/code/beta", {
      parentThreadId: "1",
      relationshipToParent: "fork",
      sideChat: true,
    }),
  ]);
  expect(sections.map((section) => section.title)).toEqual(["alpha", "beta"]);
  expect(sections[0].threads.map((item) => item.threadId)).toEqual(["1", "2"]);
  expect(sections[1].threads.map((item) => item.threadId)).toEqual(["4"]);
});
