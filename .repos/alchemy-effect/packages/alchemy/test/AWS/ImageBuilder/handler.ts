import { InstanceProfile } from "@/AWS/IAM/InstanceProfile.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import * as ImageBuilder from "@/AWS/ImageBuilder";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ImageBuilderTestFunction extends Lambda.Function<Lambda.Function>()(
  "ImageBuilderTestFunction",
) {}

const componentData = [
  "name: alchemy-imagebuilder-bindings-component",
  "description: no-op component used by alchemy binding tests",
  "schemaVersion: 1.0",
  "phases:",
  "  - name: build",
  "    steps:",
  "      - name: hello",
  "        action: ExecuteBash",
  "        inputs:",
  "          commands:",
  "            - echo hello-from-alchemy-bindings",
].join("\n");

export default ImageBuilderTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The pipeline the pipeline-scoped bindings are bound to. ENABLED but
    // with no schedule, so it only builds when the Start binding fires.
    const role = yield* Role("BindingsBuilderRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder",
        "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      ],
    });
    const profile = yield* InstanceProfile("BindingsBuilderProfile", {
      roleName: role.roleName,
    });
    const component = yield* ImageBuilder.Component("BindingsComponent", {
      platform: "Linux",
      data: componentData,
    });
    const recipe = yield* ImageBuilder.ImageRecipe("BindingsRecipe", {
      // The testing account deploys to us-west-2 (region is fixed here
      // because AWSEnvironment is deploy-only and this effect re-runs at
      // Lambda init).
      parentImage:
        "arn:aws:imagebuilder:us-west-2:aws:image/amazon-linux-2023-x86/x.x.x",
      components: [{ componentArn: component.componentBuildVersionArn }],
    });
    const infra = yield* ImageBuilder.InfrastructureConfiguration(
      "BindingsInfra",
      {
        instanceProfileName: profile.instanceProfileName,
        instanceTypes: ["t3.micro"],
        terminateInstanceOnFailure: true,
      },
    );
    const pipeline = yield* ImageBuilder.ImagePipeline("BindingsPipeline", {
      imageRecipeArn: recipe.imageRecipeArn,
      infrastructureConfigurationArn: infra.infrastructureConfigurationArn,
      // Disable tests so a cancelled build never proceeds to a test phase.
      imageTestsConfiguration: { imageTestsEnabled: false, timeout: "1 hour" },
    });

    // Event source: subscribe the host to image state-change events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* ImageBuilder.consumeImageEvents(
      { kinds: ["image-state-change"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `image state change: ${event.resources[0]} -> ${event.detail.state?.status}`,
          ),
        ),
    );

    const getPipeline = yield* ImageBuilder.GetImagePipeline(pipeline);
    const listPipelineImages =
      yield* ImageBuilder.ListImagePipelineImages(pipeline);
    const startBuild =
      yield* ImageBuilder.StartImagePipelineExecution(pipeline);
    const getImage = yield* ImageBuilder.GetImage();
    const cancelBuild = yield* ImageBuilder.CancelImageCreation();
    const deleteImage = yield* ImageBuilder.DeleteImage();
    const listImages = yield* ImageBuilder.ListImages();
    const listWorkflowExecutions = yield* ImageBuilder.ListWorkflowExecutions();
    const listImageBuildVersions = yield* ImageBuilder.ListImageBuildVersions();
    const listImagePackages = yield* ImageBuilder.ListImagePackages();
    const listImageScanFindings = yield* ImageBuilder.ListImageScanFindings();
    const listImageScanFindingAggregations =
      yield* ImageBuilder.ListImageScanFindingAggregations();
    const getWorkflowExecution = yield* ImageBuilder.GetWorkflowExecution();
    const getWorkflowStepExecution =
      yield* ImageBuilder.GetWorkflowStepExecution();
    const listWorkflowStepExecutions =
      yield* ImageBuilder.ListWorkflowStepExecutions();
    const listWaitingWorkflowSteps =
      yield* ImageBuilder.ListWaitingWorkflowSteps();
    const sendWorkflowStepAction = yield* ImageBuilder.SendWorkflowStepAction();
    const retryImage = yield* ImageBuilder.RetryImage();

    const bound = {
      getPipeline,
      listPipelineImages,
      startBuild,
      getImage,
      cancelBuild,
      deleteImage,
      listImages,
      listWorkflowExecutions,
      listImageBuildVersions,
      listImagePackages,
      listImageScanFindings,
      listImageScanFindingAggregations,
      getWorkflowExecution,
      getWorkflowStepExecution,
      listWorkflowStepExecutions,
      listWaitingWorkflowSteps,
      // Approving needs a build paused on WAIT_FOR_ACTION and retrying needs
      // a FAILED build, so the suite only proves registration/IAM wiring for
      // these two.
      sendWorkflowStepAction,
      retryImage,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const arn = url.searchParams.get("arn") ?? "";
        const id = url.searchParams.get("id") ?? "";

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Pipeline-scoped read: the pipeline ARN is injected.
        if (request.method === "GET" && pathname === "/pipeline") {
          const { imagePipeline } = yield* getPipeline();
          return yield* HttpServerResponse.json({
            arn: imagePipeline?.arn,
            name: imagePipeline?.name,
            status: imagePipeline?.status,
            timeoutMinutes:
              imagePipeline?.imageTestsConfiguration?.timeoutMinutes,
          });
        }

        // Pipeline-scoped list of the builds this pipeline produced.
        if (request.method === "GET" && pathname === "/pipeline-images") {
          const { imageSummaryList } = yield* listPipelineImages();
          return yield* HttpServerResponse.json({
            arns: (imageSummaryList ?? []).map((image) => image.arn),
          });
        }

        // Account-level image listing.
        if (request.method === "GET" && pathname === "/images") {
          const { imageVersionList } = yield* listImages({ owner: "Self" });
          return yield* HttpServerResponse.json({
            count: (imageVersionList ?? []).length,
          });
        }

        // Kick off a build of the bound pipeline.
        if (request.method === "POST" && pathname === "/build/start") {
          const { imageBuildVersionArn } = yield* startBuild();
          return yield* HttpServerResponse.json({ imageBuildVersionArn });
        }

        // Cancel an in-flight build. Early build states can briefly reject
        // cancellation — report the typed tag so the test can poll.
        if (request.method === "POST" && pathname === "/build/cancel") {
          const result = yield* cancelBuild({
            imageBuildVersionArn: arn,
          }).pipe(
            Effect.map(({ imageBuildVersionArn }) => ({
              imageBuildVersionArn,
            })),
            Effect.catchTag(
              [
                "ResourceInUseException",
                "InvalidRequestException",
                // The build version is not visible immediately after start.
                "ResourceNotFoundException",
              ],
              (error) => Effect.succeed({ reason: error._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Read a build version's state.
        if (request.method === "GET" && pathname === "/build") {
          const { image } = yield* getImage({ imageBuildVersionArn: arn });
          return yield* HttpServerResponse.json({
            status: image?.state?.status,
          });
        }

        // Drill into the build's workflow runs.
        if (request.method === "GET" && pathname === "/build/workflows") {
          const { workflowExecutions } = yield* listWorkflowExecutions({
            imageBuildVersionArn: arn,
          });
          return yield* HttpServerResponse.json({
            ids: (workflowExecutions ?? []).flatMap((execution) =>
              execution.workflowExecutionId !== undefined
                ? [execution.workflowExecutionId]
                : [],
            ),
          });
        }

        // List the build versions of an image version.
        if (request.method === "GET" && pathname === "/build-versions") {
          const { imageSummaryList } = yield* listImageBuildVersions({
            imageVersionArn: arn,
          });
          return yield* HttpServerResponse.json({
            arns: (imageSummaryList ?? []).flatMap((image) =>
              image.arn !== undefined ? [image.arn] : [],
            ),
          });
        }

        // Packages only exist once a build is AVAILABLE; earlier states
        // report the typed rejection so the test can assert it.
        if (request.method === "GET" && pathname === "/build/packages") {
          const result = yield* listImagePackages({
            imageBuildVersionArn: arn,
          }).pipe(
            Effect.map(({ imagePackageList }) => ({
              count: (imagePackageList ?? []).length,
            })),
            Effect.catchTag(
              ["InvalidRequestException", "ResourceNotFoundException"],
              (error) => Effect.succeed({ reason: error._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Account-level Inspector scan findings (empty unless scanning is
        // enabled somewhere in the account).
        if (request.method === "GET" && pathname === "/scan-findings") {
          const { findings } = yield* listImageScanFindings();
          return yield* HttpServerResponse.json({
            count: (findings ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/scan-aggregations") {
          const { responses } = yield* listImageScanFindingAggregations();
          return yield* HttpServerResponse.json({
            count: (responses ?? []).length,
          });
        }

        // Steps across the account waiting on WAIT_FOR_ACTION.
        if (request.method === "GET" && pathname === "/waiting-steps") {
          const { steps } = yield* listWaitingWorkflowSteps();
          return yield* HttpServerResponse.json({
            count: (steps ?? []).length,
          });
        }

        // Read one workflow execution by id.
        if (request.method === "GET" && pathname === "/workflow-execution") {
          const execution = yield* getWorkflowExecution({
            workflowExecutionId: id,
          });
          return yield* HttpServerResponse.json({
            id: execution.workflowExecutionId,
            type: execution.type,
            status: execution.status,
          });
        }

        // List the steps of one workflow execution.
        if (request.method === "GET" && pathname === "/workflow-steps") {
          const { steps } = yield* listWorkflowStepExecutions({
            workflowExecutionId: id,
          });
          return yield* HttpServerResponse.json({
            ids: (steps ?? []).flatMap((step) =>
              step.stepExecutionId !== undefined ? [step.stepExecutionId] : [],
            ),
          });
        }

        // Read one workflow step by id.
        if (request.method === "GET" && pathname === "/workflow-step") {
          const step = yield* getWorkflowStepExecution({
            stepExecutionId: id,
          });
          return yield* HttpServerResponse.json({
            name: step.name,
            status: step.status,
          });
        }

        // Prune a build version; not-yet-deletable states report why so the
        // test can poll until the build settles.
        if (request.method === "DELETE" && pathname === "/build") {
          const result = yield* deleteImage({
            imageBuildVersionArn: arn,
          }).pipe(
            Effect.map(() => ({ deleted: true as const })),
            // Already gone — deletion is idempotent.
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ deleted: true as const }),
            ),
            Effect.catchTag(
              ["InvalidRequestException", "ResourceDependencyException"],
              (error) =>
                Effect.succeed({ deleted: false as const, reason: error._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        ImageBuilder.GetImagePipelineHttp,
        ImageBuilder.ListImagePipelineImagesHttp,
        ImageBuilder.StartImagePipelineExecutionHttp,
        ImageBuilder.GetImageHttp,
        ImageBuilder.CancelImageCreationHttp,
        ImageBuilder.DeleteImageHttp,
        ImageBuilder.ListImagesHttp,
        ImageBuilder.ListWorkflowExecutionsHttp,
        ImageBuilder.ListImageBuildVersionsHttp,
        ImageBuilder.ListImagePackagesHttp,
        ImageBuilder.ListImageScanFindingsHttp,
        ImageBuilder.ListImageScanFindingAggregationsHttp,
        ImageBuilder.GetWorkflowExecutionHttp,
        ImageBuilder.GetWorkflowStepExecutionHttp,
        ImageBuilder.ListWorkflowStepExecutionsHttp,
        ImageBuilder.ListWaitingWorkflowStepsHttp,
        ImageBuilder.SendWorkflowStepActionHttp,
        ImageBuilder.RetryImageHttp,
      ),
    ),
  ),
);
