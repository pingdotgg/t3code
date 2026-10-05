import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  probe,
  currentProject,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsInstructions on a missing instruction fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        probe(
          datalabeling.getProjectsInstructions({
            name: `projects/${project}/instructions/alchemy-missing-instruction`,
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalabeling", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, replace, and delete an instruction",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataLabeling.Instruction("HowTo", {
            displayName: "image-classes",
            dataType: "IMAGE",
            description: "label each photo",
            pdfInstruction: {
              gcsFileUri: `gs://${project}-datalabeling/instructions.pdf`,
            },
          });
        }),
      );

      expect(created.name).toContain("/instructions/");
      expect(created.displayName).toEqual("image-classes");
      expect(created.dataType).toEqual("IMAGE");
      expect(created.description).toEqual("label each photo");

      const fetched = yield* datalabeling.getProjectsInstructions({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataLabeling.Instruction("HowTo", {
            instructionId: created.instructionId,
            displayName: "image-classes",
            dataType: "IMAGE",
            description: "updated labeling notes",
            pdfInstruction: {
              gcsFileUri: `gs://${project}-datalabeling/instructions.pdf`,
            },
          });
        }),
      );

      expect(updated.description).toEqual("updated labeling notes");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datalabeling.getProjectsInstructions({ name: updated.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalabeling", "live"],
    timeout: 90_000,
  },
);
