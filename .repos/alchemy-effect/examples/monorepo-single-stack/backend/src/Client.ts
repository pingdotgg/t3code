import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { BackendApi } from "./Spec.ts";

export const BackendClient = (baseUrl: string) =>
  HttpApiClient.make(BackendApi, { baseUrl });
