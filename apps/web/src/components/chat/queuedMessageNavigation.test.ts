import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { queuedMessageNavigationTarget as target } from "./queuedMessageNavigation";

const first = RunId.make("first");
const second = RunId.make("second");
const third = RunId.make("third");
const queue = [first, second, third];

describe("queued message navigation", () => {
  it("walks backward from the draft and forward back to it", () => {
    expect(target(queue, null, "previous")).toBe(third);
    expect(target(queue, third, "previous")).toBe(second);
    expect(target(queue, second, "previous")).toBe(first);
    expect(target(queue, first, "previous")).toBe(first);
    expect(target(queue, first, "next")).toBe(second);
    expect(target(queue, second, "next")).toBe(third);
    expect(target(queue, third, "next")).toBe("draft");
    expect(target(queue, null, "next")).toBeNull();
  });
  it("handles empty and single-entry queues", () => {
    expect(target([], null, "previous")).toBeNull();
    expect(target([], null, "next")).toBeNull();
    expect(target([first], null, "previous")).toBe(first);
    expect(target([first], first, "previous")).toBe(first);
    expect(target([first], first, "next")).toBe("draft");
  });
  it("tracks run identity after a reorder or removal", () => {
    expect(target([third, first, second], first, "previous")).toBe(third);
    expect(target([third, first, second], first, "next")).toBe(second);
    expect(target([first, third], third, "previous")).toBe(first);
    expect(target([first, third], first, "next")).toBe(third);
  });
  it("leaves recovery of an edited run that disappeared to the caller", () => {
    expect(target([first, third], second, "previous")).toBeNull();
    expect(target([], second, "next")).toBeNull();
  });
});
