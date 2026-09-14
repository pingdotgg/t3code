/**
 * Railway CLI `up` equivalent: POST a gzipped Docker context to
 * backboard `/project/:id/environment/:id/up`. Railway builds the
 * generated Dockerfile; Alchemy never pushes an image.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { RailwayEnvironment } from "./Environment.ts";

export class DeployUploadFailed extends Data.TaggedError(
  "Railway.DeployUploadFailed",
)<{
  status: number;
  message: string;
}> {}

export type UpResponse = {
  readonly deploymentId: string;
  readonly url: string;
  readonly logsUrl: string;
  readonly deploymentDomain: string;
};

const parseUpResponse = (value: unknown): UpResponse | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.deploymentId !== "string" || rec.deploymentId.length === 0) {
    return undefined;
  }
  return {
    deploymentId: rec.deploymentId,
    url: typeof rec.url === "string" ? rec.url : "",
    logsUrl: typeof rec.logsUrl === "string" ? rec.logsUrl : "",
    deploymentDomain:
      typeof rec.deploymentDomain === "string" ? rec.deploymentDomain : "",
  };
};

const uploadUrl = (input: {
  apiBaseUrl: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  message?: string;
}): string => {
  const base = input.apiBaseUrl.replace(/\/+$/, "");
  const url = new URL(
    `${base}/project/${input.projectId}/environment/${input.environmentId}/up`,
  );
  url.searchParams.set("serviceId", input.serviceId);
  if (input.message !== undefined && input.message.length > 0) {
    url.searchParams.set("message", input.message);
  }
  return url.toString();
};

/**
 * Upload a gzipped tar of a generated Docker context. Railway builds
 * and deploys it. Same contract as `railway up`.
 */
export const uploadDeployTarball = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  tarball: Uint8Array;
  message?: string;
}) {
  const env = yield* yield* RailwayEnvironment;
  const http = yield* HttpClient.HttpClient;
  const token = Redacted.value(env.token);
  const url = uploadUrl({
    apiBaseUrl: env.apiBaseUrl,
    projectId: input.projectId,
    environmentId: input.environmentId,
    serviceId: input.serviceId,
    message: input.message,
  });
  let request = HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyUint8Array(input.tarball, "application/gzip"),
  );
  request =
    env.tokenKind === "project"
      ? request.pipe(HttpClientRequest.setHeader("Project-Access-Token", token))
      : request.pipe(HttpClientRequest.bearerToken(token));
  const response = yield* http.execute(request);
  if (response.status !== 200) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new DeployUploadFailed({
      status: response.status,
      message:
        body.length > 0
          ? body
          : `Failed to upload code with status ${String(response.status)}`,
    });
  }
  const json = yield* response.json;
  const parsed = parseUpResponse(json);
  if (parsed === undefined) {
    return yield* new DeployUploadFailed({
      status: response.status,
      message: "Railway /up did not return a deploymentId",
    });
  }
  return parsed;
});
