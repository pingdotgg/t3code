import { type ServerConfig, ServerNpmReleaseError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentAtomList } from "./environmentAtomList";
import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const isServerNpmReleaseError = Schema.is(ServerNpmReleaseError);

function unsupportedLookup(config: ServerConfig | null): ServerNpmReleaseError | null {
  if (config === null) {
    return new ServerNpmReleaseError({ reason: "Connect to this server to check releases." });
  }
  return config.environment.capabilities.npmReleaseLookup === true
    ? null
    : new ServerNpmReleaseError({
        reason: "This server does not support registry lookups. Update it before switching tracks.",
      });
}

export function npmReleaseFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isServerNpmReleaseError(error)
    ? error.message
    : "Could not check this environment's npm registry. Check the connection and registry settings.";
}

export const npmReleaseAtom = Atom.family((spec: string) =>
  Atom.make((get) => {
    const primary = get(primaryEnvironmentIdAtom);
    // With the desktop's local server turned off there is no primary, so a connected server answers.
    const candidates =
      primary === null ? get(environmentSummaries.connectedEnvironmentIdsAtom) : [primary];
    const environmentId =
      candidates.find(
        (id) => unsupportedLookup(get(serverEnvironment.configValueAtom(id))) === null,
      ) ?? candidates[0];
    if (environmentId === undefined) {
      return Effect.fail(
        new ServerNpmReleaseError({ reason: "Connect to a server to check releases." }),
      );
    }
    const unsupported = unsupportedLookup(get(serverEnvironment.configValueAtom(environmentId)));
    if (unsupported !== null) return Effect.fail(unsupported);
    return get
      .result(serverEnvironment.npmRelease({ environmentId, input: { spec } }))
      .pipe(
        Effect.map((release) =>
          release === null
            ? null
            : { version: release.version, databaseMigration: release.databaseMigration },
        ),
      );
  }).pipe(Atom.withLabel(`npm-release:${spec}`)),
);

export const npmReleasePublishedAtom = Atom.family((version: string) =>
  environmentAtomList(`npm-release-published:${version}`, (environmentId) =>
    Atom.make((get) => {
      const unsupported = unsupportedLookup(get(serverEnvironment.configValueAtom(environmentId)));
      if (unsupported !== null) return { published: false, reason: unsupported.message };
      const release = get(
        serverEnvironment.npmRelease({ environmentId, input: { spec: version } }),
      );
      if (AsyncResult.isFailure(release)) {
        return { published: false, reason: npmReleaseFailureMessage(release.cause) };
      }
      if (AsyncResult.isSuccess(release) && release.value === null) {
        return {
          published: false,
          reason: `t3@${version} is not in this environment's npm registry yet`,
        };
      }
      return { published: AsyncResult.isSuccess(release), reason: null };
    }),
  ),
);
