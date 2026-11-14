import {
  ACP_REGISTRY_MAX_AGENTS,
  AcpRegistryOperationError,
  AcpRegistryOperationErrorReason,
  TrimmedNonEmptyString,
  type AcpRegistryManagedBinaryUninstallInput,
  type AcpRegistryManagedBinaryUninstallResult,
  type AcpRegistryPrepareInput,
  type AcpRegistryPrepareResult,
  type AcpRegistrySearchInput,
  type AcpRegistrySearchResult,
  type AcpRegistryDistribution as AcpRegistryDistributionKind,
} from "@t3tools/contracts";
import type { AcpRegistryDistributionPreference } from "../settings.ts";
import type { AcpRegistrySettings } from "../settings.ts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  mergePathEntries,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { sha256 } from "@noble/hashes/sha2";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";


import {
} from "./AcpRegistryModel.ts";
import { makeAcpRegistryIndex } from "./AcpRegistryIndex.ts";
import { makeAcpRegistryInstaller } from "./AcpRegistryInstaller.ts";
import { makeAcpRegistryCatalogService } from "./AcpRegistryCatalogService.ts";
import type { AcpRegistryCatalog, AcpRegistryCatalogOptions } from "./AcpRegistryModel.ts";

export * from "./AcpRegistryModel.ts";

export const makeAcpRegistryCatalog = Effect.fn("AcpRegistryCatalog.make")(function* (
  input: AcpRegistryCatalogOptions,
): Effect.fn.Return<
  AcpRegistryCatalog["Service"],
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | Digest.Digest
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderHost.ProviderHost
> {
  const index = yield* makeAcpRegistryIndex(input);
  const catalog = yield* makeAcpRegistryInstaller(index);
  return makeAcpRegistryCatalogService(catalog);
});
