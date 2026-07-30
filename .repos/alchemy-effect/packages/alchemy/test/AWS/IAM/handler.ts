import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class IamTestFunction extends Lambda.Function<Lambda.Function>()(
  "IamTestFunction",
) {}

/**
 * A permissive-but-harmless custom policy used by the simulator and
 * context-key routes. The `aws:username` condition guarantees
 * GetContextKeysForCustomPolicy returns a non-empty key list.
 */
const CUSTOM_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:ListAllMyBuckets"],
      Resource: "*",
      Condition: { StringLike: { "aws:username": "*" } },
    },
  ],
});

export default IamTestFunction.make(
  {
    main,
    url: true,
    // Credential-report + access-advisor routes poll (bounded) for report
    // generation; the AWS default 3s Lambda timeout is far too tight.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The IAM entity the principal-scoped routes interrogate. The inline
    // policy grants s3:ListAllMyBuckets so the access-advisor job lists the
    // s3 namespace and the principal simulation evaluates to "allowed".
    const user = yield* IAM.User("BindingsUser", {
      inlinePolicies: {
        AllowListBuckets: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:ListAllMyBuckets"],
              Resource: ["*"],
            },
          ],
        },
      },
      tags: { fixture: "iam-bindings" },
    });

    const accessKey = yield* IAM.AccessKey("BindingsUserKey", {
      userName: user.userName,
    });

    // Output accessors: yielding at init returns an *accessor* effect that
    // must be yielded again inside the runtime route to get the value.
    const userArn = yield* user.userArn;
    const userName = yield* user.userName;

    // --- account-audit bindings ---
    const getAccountSummary = yield* IAM.GetAccountSummary();
    const getAccountAuthorizationDetails =
      yield* IAM.GetAccountAuthorizationDetails();

    // --- credential report ---
    const generateCredentialReport = yield* IAM.GenerateCredentialReport();
    const getCredentialReport = yield* IAM.GetCredentialReport();

    // --- access advisor ---
    const generateServiceLastAccessedDetails =
      yield* IAM.GenerateServiceLastAccessedDetails();
    const getServiceLastAccessedDetails =
      yield* IAM.GetServiceLastAccessedDetails();
    const getServiceLastAccessedDetailsWithEntities =
      yield* IAM.GetServiceLastAccessedDetailsWithEntities();
    const listPoliciesGrantingServiceAccess =
      yield* IAM.ListPoliciesGrantingServiceAccess();

    // --- policy simulation ---
    const simulateCustomPolicy = yield* IAM.SimulateCustomPolicy();
    const simulatePrincipalPolicy = yield* IAM.SimulatePrincipalPolicy();
    const getContextKeysForCustomPolicy =
      yield* IAM.GetContextKeysForCustomPolicy();
    const getContextKeysForPrincipalPolicy =
      yield* IAM.GetContextKeysForPrincipalPolicy();

    // --- access-key hygiene (scoped to the fixture's canonical AccessKey) ---
    const getAccessKeyLastUsed = yield* IAM.GetAccessKeyLastUsed(accessKey);

    const bound = {
      getAccountSummary,
      getAccountAuthorizationDetails,
      generateCredentialReport,
      getCredentialReport,
      generateServiceLastAccessedDetails,
      getServiceLastAccessedDetails,
      getServiceLastAccessedDetailsWithEntities,
      listPoliciesGrantingServiceAccess,
      simulateCustomPolicy,
      simulatePrincipalPolicy,
      getContextKeysForCustomPolicy,
      getContextKeysForPrincipalPolicy,
      getAccessKeyLastUsed,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/account-summary") {
          const { SummaryMap } = yield* getAccountSummary();
          return yield* HttpServerResponse.json({
            keys: Object.keys(SummaryMap ?? {}).length,
            users: SummaryMap?.Users ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/authorization-details") {
          const { UserDetailList } = yield* getAccountAuthorizationDetails({
            Filter: ["User"],
            MaxItems: 100,
          });
          return yield* HttpServerResponse.json({
            users: (UserDetailList ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/credential-report") {
          // Kick off generation (idempotent — returns STARTED/INPROGRESS/
          // COMPLETE), then poll the report with a bounded retry on the two
          // typed not-ready tags. A genuine IAM gap surfaces as
          // AccessDeniedException and 500s the route instead.
          yield* generateCredentialReport();
          const result = yield* getCredentialReport().pipe(
            Effect.retry({
              while: (e): boolean =>
                e._tag === "CredentialReportNotPresentException" ||
                e._tag === "CredentialReportNotReadyException",
              schedule: Schedule.spaced("2 seconds"),
              times: 8,
            }),
            Effect.map((r) => ({
              tag: "Ok",
              bytes: r.Content?.length ?? 0,
              format: r.ReportFormat ?? null,
            })),
            Effect.catchTag(
              [
                "CredentialReportNotPresentException",
                "CredentialReportNotReadyException",
              ],
              (e) => Effect.succeed({ tag: e._tag, bytes: 0, format: null }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/service-last-accessed") {
          // Access-advisor round trip against the fixture user: generate the
          // job, briefly poll until it leaves IN_PROGRESS, then drill into
          // the s3 namespace (guaranteed present — the user's inline policy
          // allows s3). Keep this well below the Lambda timeout: under
          // parallel test load the IAM calls themselves can be slow, and the
          // caller already accepts IN_PROGRESS as a valid asynchronous state.
          const { JobId } = yield* generateServiceLastAccessedDetails({
            Arn: yield* userArn,
          });
          const details = yield* getServiceLastAccessedDetails({
            JobId: JobId!,
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (r): boolean => r.JobStatus !== "IN_PROGRESS",
              times: 3,
            }),
          );
          if (details.JobStatus !== "COMPLETED") {
            return yield* HttpServerResponse.json({
              status: details.JobStatus,
              services: 0,
              entities: null,
            });
          }
          const withEntities = yield* getServiceLastAccessedDetailsWithEntities(
            {
              JobId: JobId!,
              ServiceNamespace: "s3",
            },
          );
          return yield* HttpServerResponse.json({
            status: details.JobStatus,
            services: (details.ServicesLastAccessed ?? []).length,
            entities: (withEntities.EntityDetailsList ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/policies-granting-access"
        ) {
          const { PoliciesGrantingServiceAccess } =
            yield* listPoliciesGrantingServiceAccess({
              Arn: yield* userArn,
              ServiceNamespaces: ["s3"],
            });
          const s3 = (PoliciesGrantingServiceAccess ?? []).find(
            (entry) => entry.ServiceNamespace === "s3",
          );
          return yield* HttpServerResponse.json({
            policies: (s3?.Policies ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/simulate-custom") {
          const { EvaluationResults } = yield* simulateCustomPolicy({
            PolicyInputList: [CUSTOM_POLICY],
            ActionNames: ["s3:ListAllMyBuckets"],
            ContextEntries: [
              {
                ContextKeyName: "aws:username",
                ContextKeyType: "string",
                ContextKeyValues: ["alchemy-test"],
              },
            ],
          });
          return yield* HttpServerResponse.json({
            decision: EvaluationResults?.[0]?.EvalDecision ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/simulate-principal") {
          const { EvaluationResults } = yield* simulatePrincipalPolicy({
            PolicySourceArn: yield* userArn,
            ActionNames: ["s3:ListAllMyBuckets"],
          });
          return yield* HttpServerResponse.json({
            decision: EvaluationResults?.[0]?.EvalDecision ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/context-keys-custom") {
          const { ContextKeyNames } = yield* getContextKeysForCustomPolicy({
            PolicyInputList: [CUSTOM_POLICY],
          });
          return yield* HttpServerResponse.json({
            contextKeys: ContextKeyNames ?? [],
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/context-keys-principal"
        ) {
          const { ContextKeyNames } = yield* getContextKeysForPrincipalPolicy({
            PolicySourceArn: yield* userArn,
          });
          return yield* HttpServerResponse.json({
            contextKeys: ContextKeyNames ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/access-key-last-used") {
          // The binding injects the fixture key's AccessKeyId; a fresh key
          // has no last-used data but the owning user name is always echoed.
          const { UserName, AccessKeyLastUsed } = yield* getAccessKeyLastUsed();
          return yield* HttpServerResponse.json({
            userName: UserName ?? null,
            expectedUserName: yield* userName,
            lastUsedService: AccessKeyLastUsed?.ServiceName ?? null,
          });
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
        IAM.GetAccountSummaryHttp,
        IAM.GetAccountAuthorizationDetailsHttp,
        IAM.GenerateCredentialReportHttp,
        IAM.GetCredentialReportHttp,
        IAM.GenerateServiceLastAccessedDetailsHttp,
        IAM.GetServiceLastAccessedDetailsHttp,
        IAM.GetServiceLastAccessedDetailsWithEntitiesHttp,
        IAM.ListPoliciesGrantingServiceAccessHttp,
        IAM.SimulateCustomPolicyHttp,
        IAM.SimulatePrincipalPolicyHttp,
        IAM.GetContextKeysForCustomPolicyHttp,
        IAM.GetContextKeysForPrincipalPolicyHttp,
        IAM.GetAccessKeyLastUsedHttp,
      ),
    ),
  ),
);
