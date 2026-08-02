import * as AWS from "@/AWS";
import { Job, JobTemplate, Preset, Queue } from "@/AWS/MediaConvert";
import * as Test from "@/Test/Alchemy";
import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic, run-stable physical names (never Date.now()).
const QUEUE_NAME = "alchemy-test-mc-queue";
const PRESET_NAME = "alchemy-test-mc-preset";
const TEMPLATE_NAME = "alchemy-test-mc-jobtemplate";

// A minimal, valid H.264 / AAC MP4 output preset.
const PRESET_SETTINGS: mediaconvert.PresetSettings = {
  ContainerSettings: { Container: "MP4", Mp4Settings: {} },
  VideoDescription: {
    Width: 1280,
    Height: 720,
    CodecSettings: {
      Codec: "H_264",
      H264Settings: {
        RateControlMode: "QVBR",
        MaxBitrate: 3000000,
        SceneChangeDetect: "TRANSITION_DETECTION",
      },
    },
  },
  AudioDescriptions: [
    {
      CodecSettings: {
        Codec: "AAC",
        AacSettings: {
          Bitrate: 96000,
          CodingMode: "CODING_MODE_2_0",
          SampleRate: 48000,
        },
      },
    },
  ],
};

// A minimal, valid single-output file-group job template.
const TEMPLATE_SETTINGS: mediaconvert.JobTemplateSettings = {
  Inputs: [
    { TimecodeSource: "ZEROBASED", VideoSelector: {}, AudioSelectors: {} },
  ],
  OutputGroups: [
    {
      Name: "File Group",
      OutputGroupSettings: {
        Type: "FILE_GROUP_SETTINGS",
        FileGroupSettings: {},
      },
      Outputs: [
        {
          ContainerSettings: { Container: "MP4", Mp4Settings: {} },
          VideoDescription: {
            CodecSettings: {
              Codec: "H_264",
              H264Settings: {
                RateControlMode: "QVBR",
                MaxBitrate: 3000000,
                SceneChangeDetect: "TRANSITION_DETECTION",
              },
            },
          },
        },
      ],
    },
  ],
};

class StillExists extends Data.TaggedError("StillExists")<{
  readonly name: string;
}> {}

// ---------------------------------------------------------------------------
// Ungated typed-error probes — prove the distilled error union carries the
// not-found tag the read/delete paths depend on, at near-zero cost.
// ---------------------------------------------------------------------------

test.provider(
  "getQueue/getPreset/getJobTemplate on a missing name fail with NotFoundException",
  () =>
    Effect.gen(function* () {
      const q = yield* Effect.flip(
        mediaconvert.getQueue({ Name: "alchemy-does-not-exist-000" }),
      );
      expect(q._tag).toBe("NotFoundException");
      const p = yield* Effect.flip(
        mediaconvert.getPreset({ Name: "alchemy-does-not-exist-000" }),
      );
      expect(p._tag).toBe("NotFoundException");
      const t = yield* Effect.flip(
        mediaconvert.getJobTemplate({ Name: "alchemy-does-not-exist-000" }),
      );
      expect(t._tag).toBe("NotFoundException");
    }),
);

test.provider(
  "createJob with an invalid role is rejected with a typed BadRequestException",
  () =>
    Effect.gen(function* () {
      // Proves Job's create path has a typed error union (no untyped catch-all)
      // without submitting a billable transcode.
      const error = yield* Effect.flip(
        mediaconvert.createJob({
          Role: "arn:aws:iam::000000000000:role/does-not-exist",
          Settings: {
            Inputs: [{ FileInput: "s3://alchemy-nonexistent/in.mp4" }],
            OutputGroups: TEMPLATE_SETTINGS.OutputGroups,
          },
        }),
      );
      // A bad role surfaces as a typed tag (AccessDenied/BadRequest/Forbidden),
      // never the untyped catch-all — that is the point of the probe.
      expect(error._tag).not.toBe("UnknownAwsError");
      expect([
        "AccessDeniedException",
        "BadRequestException",
        "ForbiddenException",
      ]).toContain(error._tag);
    }),
);

// ---------------------------------------------------------------------------
// Queue lifecycle — on-demand queues are free and provision instantly.
// ---------------------------------------------------------------------------

test.provider(
  "Queue: create, update, and destroy an on-demand queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("Q", {
            queueName: QUEUE_NAME,
            description: "alchemy test queue",
            tags: { Environment: "test" },
          });
        }),
      );
      expect(created.queueName).toBe(QUEUE_NAME);
      expect(created.queueArn).toContain(":queues/");
      expect(created.pricingPlan).toBe("ON_DEMAND");
      expect(created.status).toBe("ACTIVE");

      // Out-of-band verification. MediaConvert returns tags only via
      // listTagsForResource, not in the Get response body.
      const observed = yield* mediaconvert.getQueue({ Name: QUEUE_NAME });
      expect(observed.Queue?.Description).toBe("alchemy test queue");
      const queueTags = yield* mediaconvert.listTagsForResource({
        Arn: created.queueArn,
      });
      expect(queueTags.ResourceTags?.Tags?.["alchemy::id"]).toBe("Q");

      // Update: change description + pause the queue.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("Q", {
            queueName: QUEUE_NAME,
            description: "alchemy test queue v2",
            status: "PAUSED",
            tags: { Environment: "test", Extra: "yes" },
          });
        }),
      );
      expect(updated.status).toBe("PAUSED");

      const observed2 = yield* mediaconvert.getQueue({ Name: QUEUE_NAME });
      expect(observed2.Queue?.Description).toBe("alchemy test queue v2");
      expect(observed2.Queue?.Status).toBe("PAUSED");
      const queueTags2 = yield* mediaconvert.listTagsForResource({
        Arn: created.queueArn,
      });
      expect(queueTags2.ResourceTags?.Tags?.["Extra"]).toBe("yes");

      yield* stack.destroy();
      yield* assertQueueDeleted(QUEUE_NAME);
    }),
  { timeout: 120_000 },
);

// ---------------------------------------------------------------------------
// Preset lifecycle.
// ---------------------------------------------------------------------------

test.provider(
  "Preset: create, update, and destroy an output preset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Preset("P", {
            presetName: PRESET_NAME,
            description: "alchemy test preset",
            settings: PRESET_SETTINGS,
            tags: { Environment: "test" },
          });
        }),
      );
      expect(created.presetName).toBe(PRESET_NAME);
      expect(created.presetArn).toContain(":presets/");
      expect(created.type).toBe("CUSTOM");

      const observed = yield* mediaconvert.getPreset({ Name: PRESET_NAME });
      expect(observed.Preset?.Description).toBe("alchemy test preset");
      const presetTags = yield* mediaconvert.listTagsForResource({
        Arn: created.presetArn,
      });
      expect(presetTags.ResourceTags?.Tags?.["alchemy::id"]).toBe("P");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Preset("P", {
            presetName: PRESET_NAME,
            description: "alchemy test preset v2",
            category: "alchemy",
            settings: PRESET_SETTINGS,
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.category).toBe("alchemy");

      const observed2 = yield* mediaconvert.getPreset({ Name: PRESET_NAME });
      expect(observed2.Preset?.Description).toBe("alchemy test preset v2");

      yield* stack.destroy();
      yield* assertPresetDeleted(PRESET_NAME);
    }),
  { timeout: 120_000 },
);

// ---------------------------------------------------------------------------
// JobTemplate lifecycle.
// ---------------------------------------------------------------------------

test.provider(
  "JobTemplate: create, update, and destroy a job template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* JobTemplate("T", {
            jobTemplateName: TEMPLATE_NAME,
            description: "alchemy test template",
            settings: TEMPLATE_SETTINGS,
            tags: { Environment: "test" },
          });
        }),
      );
      expect(created.jobTemplateName).toBe(TEMPLATE_NAME);
      expect(created.jobTemplateArn).toContain(":jobTemplates/");
      expect(created.type).toBe("CUSTOM");

      const observed = yield* mediaconvert.getJobTemplate({
        Name: TEMPLATE_NAME,
      });
      expect(observed.JobTemplate?.Description).toBe("alchemy test template");
      const templateTags = yield* mediaconvert.listTagsForResource({
        Arn: created.jobTemplateArn,
      });
      expect(templateTags.ResourceTags?.Tags?.["alchemy::id"]).toBe("T");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* JobTemplate("T", {
            jobTemplateName: TEMPLATE_NAME,
            description: "alchemy test template v2",
            priority: 10,
            settings: TEMPLATE_SETTINGS,
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.jobTemplateName).toBe(TEMPLATE_NAME);

      const observed2 = yield* mediaconvert.getJobTemplate({
        Name: TEMPLATE_NAME,
      });
      expect(observed2.JobTemplate?.Description).toBe(
        "alchemy test template v2",
      );
      expect(observed2.JobTemplate?.Priority).toBe(10);

      yield* stack.destroy();
      yield* assertJobTemplateDeleted(TEMPLATE_NAME);
    }),
  { timeout: 120_000 },
);

// ---------------------------------------------------------------------------
// Job live lifecycle — slow/billable; needs an IAM role MediaConvert can
// assume plus S3 access. Gated behind AWS_TEST_SLOW. Requires:
//   AWS_TEST_SLOW=1
//   MEDIACONVERT_ROLE_ARN=<role arn>
//   MEDIACONVERT_TEST_INPUT=s3://bucket/input.mp4
//   MEDIACONVERT_TEST_OUTPUT=s3://bucket/out/
// The job intentionally runs to completion or errors on its own; the test
// only asserts submission + a terminal-or-progressing status, then cancels.
// ---------------------------------------------------------------------------

const runJob =
  process.env.AWS_TEST_SLOW === "1" && !!process.env.MEDIACONVERT_ROLE_ARN;

test.provider.skipIf(!runJob)(
  "Job: submit a transcode and cancel it (gated AWS_TEST_SLOW=1)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const roleArn = process.env.MEDIACONVERT_ROLE_ARN!;
      const input =
        process.env.MEDIACONVERT_TEST_INPUT ??
        "s3://alchemy-nonexistent/in.mp4";
      const output =
        process.env.MEDIACONVERT_TEST_OUTPUT ?? "s3://alchemy-nonexistent/out/";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Job("J", {
            role: roleArn,
            settings: {
              Inputs: [
                {
                  FileInput: input,
                  TimecodeSource: "ZEROBASED",
                  VideoSelector: {},
                  AudioSelectors: {},
                },
              ],
              OutputGroups: [
                {
                  Name: "File Group",
                  OutputGroupSettings: {
                    Type: "FILE_GROUP_SETTINGS",
                    FileGroupSettings: { Destination: output },
                  },
                  Outputs: TEMPLATE_SETTINGS.OutputGroups![0].Outputs,
                },
              ],
            },
          });
        }),
      );
      expect(created.jobId).toBeTruthy();
      expect(created.jobArn).toContain(":jobs/");

      const observed = yield* mediaconvert.getJob({ Id: created.jobId });
      expect(observed.Job).toBeDefined();
      expect(
        ["SUBMITTED", "PROGRESSING", "COMPLETE", "ERROR"].includes(
          observed.Job!.Status!,
        ),
      ).toBe(true);

      // destroy() cancels the job if still in flight.
      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

// ---------------------------------------------------------------------------
// Deletion assertions — typed wait-until-gone.
// ---------------------------------------------------------------------------

const assertQueueDeleted = (name: string) =>
  mediaconvert.getQueue({ Name: name }).pipe(
    Effect.flatMap(() => Effect.fail(new StillExists({ name }))),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const assertPresetDeleted = (name: string) =>
  mediaconvert.getPreset({ Name: name }).pipe(
    Effect.flatMap(() => Effect.fail(new StillExists({ name }))),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const assertJobTemplateDeleted = (name: string) =>
  mediaconvert.getJobTemplate({ Name: name }).pipe(
    Effect.flatMap(() => Effect.fail(new StillExists({ name }))),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );
