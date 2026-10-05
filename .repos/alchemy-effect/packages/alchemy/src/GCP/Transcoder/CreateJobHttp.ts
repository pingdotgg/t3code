import * as transcoder from "@distilled.cloud/gcp/transcoder_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CreateJob, type CreateJobRequest } from "./CreateJob.ts";
import { lastSegment, parentOfName } from "./internal.ts";
import type { JobTemplate } from "./JobTemplate.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link CreateJob}.
 *
 * @layer
 * @provides GCP.Transcoder.CreateJob
 */
export const CreateJobHttp = Layer.effect(
  CreateJob,
  Effect.gen(function* () {
    const createProjectsLocationsJobs =
      yield* transcoder.createProjectsLocationsJobs;
    return Effect.fn(function* (template: JobTemplate) {
      yield* bindGcpHost({
        tag: "GCP.Transcoder.CreateJob",
        resource: template,
        // Narrowest predefined role with transcoder.jobs.create; Transcoder
        // has no resource-level IAM, so this is a project grant.
        iam: [{ role: "roles/transcoder.editor" }],
      });
      const name = yield* template.name;
      const location = yield* template.location;
      return Effect.fn(`GCP.Transcoder.CreateJob(${template.LogicalId})`)(
        function* (request?: CreateJobRequest) {
          const templateName = yield* name;
          const templateLocation = yield* location;
          const templateId = lastSegment(templateName);
          const config = request?.body?.config;
          return yield* createProjectsLocationsJobs({
            parent: parentOfName(templateName, templateLocation),
            body: {
              ...request?.body,
              templateId:
                request?.body?.templateId ??
                (config === undefined ? templateId : undefined),
            },
          });
        },
      );
    });
  }),
);
