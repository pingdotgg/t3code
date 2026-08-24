import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as transcribe from "@distilled.cloud/aws/transcribe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: reading a nonexistent transcription job must
// surface as a typed error from distilled's `GetTranscriptionJobError` union —
// proves the SDK's typed error mapping and that the binding's callable is wired
// against the real batch API, at zero cost (no S3 media, no job). The full
// start→poll lifecycle needs an S3 audio input and multi-minute async
// processing; it is gated behind AWS_TEST_SLOW=1.
//
// NOTE: AWS Transcribe reports a missing job as `BadRequestException` ("The
// requested job couldn't be found."), NOT `NotFoundException` — a documented
// API quirk. Both tags are in the typed union; we assert the one AWS actually
// returns.
test.provider(
  "reading a nonexistent transcription job returns a typed BadRequestException",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        transcribe.getTranscriptionJob({
          TranscriptionJobName: "alchemy-nonexistent-job-probe",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("BadRequestException");
      }
    }),
  { timeout: 60_000 },
);
