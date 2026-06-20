import { describe, expect, it, vi } from "vite-plus/test";

import {
  CloudWaitlistJoinRejectedError,
  CloudWaitlistJoinRequestError,
  joinCloudWaitlist,
} from "./cloudWaitlistJoin";

describe("joinCloudWaitlist", () => {
  it("submits the provided email address", async () => {
    const join = vi.fn().mockResolvedValue({ error: null });

    await joinCloudWaitlist({ join }, "person@example.com");

    expect(join).toHaveBeenCalledExactlyOnceWith({ emailAddress: "person@example.com" });
  });

  it("preserves Clerk rejection details without exposing the email address", async () => {
    const cause = Object.assign(new Error("The enrollment was rejected."), {
      code: "form_identifier_invalid",
    });
    const join = vi.fn().mockResolvedValue({ error: cause });

    const failure = await joinCloudWaitlist({ join }, "secret@example.com").catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CloudWaitlistJoinRejectedError);
    expect(failure).toMatchObject({
      code: "form_identifier_invalid",
      cause,
    });
    expect(String(failure)).not.toContain("secret@example.com");
  });

  it("distinguishes request failures from rejected enrollments", async () => {
    const cause = new Error("network unavailable");
    const join = vi.fn().mockRejectedValue(cause);

    const failure = await joinCloudWaitlist({ join }, "person@example.com").catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CloudWaitlistJoinRequestError);
    expect(failure).toMatchObject({ cause });
    expect(failure).not.toBeInstanceOf(CloudWaitlistJoinRejectedError);
  });
});
