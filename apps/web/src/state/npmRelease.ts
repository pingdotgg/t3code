import { type ServerConfig, ServerNpmReleaseError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const isServerNpmReleaseError = Schema.is(ServerNpmReleaseError);

function unsupportedLookup(config: ServerConfig | null): ServerNpmReleaseError | null {
  if (config === null) {
    return new ServerNpmReleaseError({
      reason: m(msg("Connect to this server to check releases.")),
    });
  }
  return config.environment.capabilities.npmReleaseLookup === true
    ? null
    : new ServerNpmReleaseError({
        reason: m(
          msg("This server does not support registry lookups. Update it before switching tracks."),
        ),
      });
}

export function npmReleaseFailureMessage(
  cause: Cause.Cause<unknown>,
  resolve: MessageResolver = m,
): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isServerNpmReleaseError(error)
    ? error.message
    : resolve(
        msg(
          "Could not check this environment's npm registry. Check the connection and registry settings.",
        ),
      );
}

export const npmReleaseLookupAtom = Atom.family((spec: string) =>
  Atom.readable((get) => {
    const primary = get(primaryEnvironmentIdAtom);
    // With the desktop's local server turned off there is no primary, so a connected server answers.
    const candidates =
      primary === null ? get(environmentSummaries.connectedEnvironmentIdsAtom) : [primary];
    const environmentId =
      candidates.find(
        (id) => unsupportedLookup(get(serverEnvironment.configValueAtom(id))) === null,
      ) ?? candidates[0];
    if (environmentId === undefined) {
      return {
        error: new ServerNpmReleaseError({
          reason: m(msg("Connect to a server to check releases.")),
        }),
      };
    }
    const error = unsupportedLookup(get(serverEnvironment.configValueAtom(environmentId)));
    return error === null
      ? { query: serverEnvironment.npmRelease({ environmentId, input: { spec } }) }
      : { error };
  }),
);

export const npmReleaseAtom = Atom.family((spec: string) =>
  Atom.make((get) => {
    const lookup = get(npmReleaseLookupAtom(spec));
    if (lookup.error !== undefined) return AsyncResult.fail(lookup.error);
    return AsyncResult.map(get(lookup.query), (release) =>
      release === null
        ? null
        : { version: release.version, databaseMigration: release.databaseMigration },
    );
  }).pipe(Atom.withLabel(`npm-release:${spec}`)),
);
