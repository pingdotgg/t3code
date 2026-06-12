import * as Layer from "effect/Layer";
import * as RpcServer from "../Local/RpcServer.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as Credentials from "./Credentials.ts";
import {
  LocalWorkerProvider,
  localRuntimeServices,
} from "./Workers/LocalWorkerProvider.ts";

const cloudflareServices = Layer.provide(
  Layer.merge(
    Credentials.fromAuthProvider(),
    CloudflareEnvironment.fromProfile(),
  ),
  CloudflareAuth,
);

LocalWorkerProvider().pipe(
  Layer.provide(localRuntimeServices()),
  Layer.provide(cloudflareServices),
  RpcServer.launch,
);
