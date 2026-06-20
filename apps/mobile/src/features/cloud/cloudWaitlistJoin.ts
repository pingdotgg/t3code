import * as Schema from "effect/Schema";

interface CloudWaitlistJoiner {
  readonly join: (input: { emailAddress: string }) => Promise<{
    readonly error: { readonly code: string } | null;
  }>;
}

export class CloudWaitlistJoinRejectedError extends Schema.TaggedErrorClass<CloudWaitlistJoinRejectedError>()(
  "CloudWaitlistJoinRejectedError",
  {
    code: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cloud waitlist enrollment was rejected with code "${this.code}".`;
  }
}

export class CloudWaitlistJoinRequestError extends Schema.TaggedErrorClass<CloudWaitlistJoinRequestError>()(
  "CloudWaitlistJoinRequestError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Cloud waitlist enrollment request failed.";
  }
}

export async function joinCloudWaitlist(
  waitlist: CloudWaitlistJoiner,
  emailAddress: string,
): Promise<void> {
  const result = await waitlist.join({ emailAddress }).catch((cause) => {
    throw new CloudWaitlistJoinRequestError({ cause });
  });

  if (result.error) {
    throw new CloudWaitlistJoinRejectedError({
      code: result.error.code,
      cause: result.error,
    });
  }
}
