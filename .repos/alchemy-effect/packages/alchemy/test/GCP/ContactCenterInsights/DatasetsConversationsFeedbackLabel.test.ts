import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const datasetId = "alchemy-cci-label-ds";
const conversationId = "alchemy-cci-ds-label-conv";
const namesOf = (project: string) => {
  const locationParent = `projects/${project}/locations/us-central1`;
  const datasetName = `${locationParent}/datasets/${datasetId}`;
  const conversationName = `${datasetName}/conversations/${conversationId}`;
  return { locationParent, datasetName, conversationName };
};

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsDatasetsConversationsFeedbackLabels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilDatasetGone = (name: string) =>
  cci.getProjectsLocationsDatasets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const ensureDataset = ({
  locationParent,
  datasetName,
}: ReturnType<typeof namesOf>) =>
  cci.getProjectsLocationsDatasets({ name: datasetName }).pipe(
    Effect.catchTag("NotFound", () =>
      cci.createProjectsLocationsDatasets({
        parent: locationParent,
        datasetId,
        body: {
          displayName: "alchemy-cci-label-ds",
          type: "EVAL",
          description: "alchemy test dataset",
        },
      }),
    ),
  );

const ensureConversation = ({
  datasetName,
  conversationName,
}: ReturnType<typeof namesOf>) =>
  cci
    .getProjectsLocationsDatasetsConversations({ name: conversationName })
    .pipe(
      Effect.catchTag("NotFound", () =>
        cci.createProjectsLocationsConversations({
          parent: datasetName,
          conversationId,
          body: {
            medium: "CHAT",
            languageCode: "en-US",
            labels: { "alchemy-test": "cci" },
          },
        }),
      ),
    );

const deleteParents = ({
  datasetName,
  conversationName,
}: ReturnType<typeof namesOf>) =>
  Effect.gen(function* () {
    yield* cci
      .deleteProjectsLocationsDatasetsConversations({
        name: conversationName,
        force: true,
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    const deleted = yield* cci
      .deleteProjectsLocationsDatasets({ name: datasetName })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (deleted !== undefined) {
      yield* waitUntilDatasetGone(datasetName);
    }
  });

test.provider(
  "getProjectsLocationsDatasetsConversationsFeedbackLabels on a missing label fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const names = namesOf(project);
      const { conversationName } = names;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsDatasetsConversationsFeedbackLabels({
          name: `${conversationName}/feedbackLabels/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);

// The fixture creates its dataset conversation with
// createProjectsLocationsConversations under a dataset parent, which the
// testing project answers with NotFound "404"; dataset conversations have
// to be ingested. Set GCP_TEST_CCI_DATASETS=1 where that path works.
test.provider.skipIf(!!process.env.FAST || !process.env.GCP_TEST_CCI_DATASETS)(
  "create, update, and delete a dataset conversation feedback label",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const names = namesOf(project);
      const { conversationName } = names;
      yield* stack.destroy();
      yield* ensureDataset(names);
      const conversation = yield* ensureConversation(names);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.DatasetsConversationsFeedbackLabel(
            "Topic",
            {
              parent: conversation.name ?? conversationName,
              label: "billing",
            },
          );
        }),
      );

      expect(created.name).toContain("/feedbackLabels/");
      expect(created.label).toEqual("billing");

      const fetched =
        yield* cci.getProjectsLocationsDatasetsConversationsFeedbackLabels({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.label).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.DatasetsConversationsFeedbackLabel(
            "Topic",
            {
              parent: conversation.name ?? conversationName,
              feedbackLabelId: created.feedbackLabelId,
              label: "invoices",
            },
          );
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.label).toEqual("invoices");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
      yield* deleteParents(names);
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 120_000,
  },
);
