import { beforeEach, describe, expect, it, vi } from "vitest";

const uuidV4Mock = vi.hoisted(() => vi.fn());

vi.mock("uuid", () => ({
  v4: uuidV4Mock,
}));

import { newCommandId, newMessageId, newProjectId, newThreadId } from "./utils";

describe("utils", () => {
  beforeEach(() => {
    uuidV4Mock.mockReset();
    uuidV4Mock.mockReturnValue("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("delegates ID generation to uuid.v4", () => {
    expect(newCommandId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(newProjectId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(newThreadId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(newMessageId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(uuidV4Mock).toHaveBeenCalledTimes(4);
  });
});
