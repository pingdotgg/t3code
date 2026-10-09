/**
 * The source control drivers this build ships with. Both registries, repository operations and
 * pull requests, iterate this list; a host with no driver here shows up as unsupported.
 *
 * Adding a host means writing its `@t3tools/source-control-<host>` package, adding its driver
 * here, and providing its services' layers in `layer` below.
 *
 * @module sourceControl/builtInDrivers
 */
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as ForgejoDriver from "@t3tools/source-control-forgejo/server/driver";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

/** Ordered as the hosts appear in discovery, after the ones still built in the server. */
export const BUILT_IN_SOURCE_CONTROL_DRIVERS = [ForgejoDriver.driver] as const;

/** The services the built-in drivers' packages own, plus the host port they all run against. */
export const layer = ForgejoCli.layer.pipe(Layer.provideMerge(ServerSourceControlHost.layer));
