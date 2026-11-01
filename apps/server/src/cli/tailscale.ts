import * as NodeUtil from "node:util";

import { ServerTailscaleStatus, TAILNET_APP_CAPABILITY } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { readTailscaleStatus, readTailscaleWhois, type TailscaleStatus } from "@t3tools/tailscale";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import { REQUIRE_GRANT_FILE } from "../auth/TailnetSignIn.ts";
import { SERVICE_ENV_FILE } from "../cloud/serviceProtocol.ts";
import { peersJoined, policyGrantedPeers } from "../auth/tailnetGrants.ts";
import { formatTailscaleHealth, readTailscaleHealth } from "../environment/TailscaleHealth.ts";
import {
  isSupportedTailscaleVersion,
  MINIMUM_TAILSCALE_VERSION,
} from "../tailscale/TailscaleHost.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const encodeStatusJson = Schema.encodeEffect(fromJsonStringPretty(ServerTailscaleStatus));

const tailscaleStatusCommand = Command.make("status", {
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable output."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show this machine's Tailscale state and what to fix."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const status = yield* readTailscaleHealth;
      yield* Console.log(
        flags.json ? yield* encodeStatusJson(status) : formatTailscaleHealth(status),
      );
    }),
  ),
);

/** Writes the state file that makes this host require a grant, as `t3 up --require-grant` does. */
export const turnOnRequireGrant = Effect.fn("cli.tailscale.turnOnRequireGrant")(function* (
  stateDir: string,
  why: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(stateDir, REQUIRE_GRANT_FILE),
    `${DateTime.formatIso(yield* DateTime.now)} ${why}\n`,
  );
});

/** Why Tailscale sign-in cannot work on this host, or null when it can. */
export const signInBlocker = (status: TailscaleStatus): string | null =>
  status.backendState !== "Running"
    ? `Tailscale is ${status.backendState ?? "not running"}. Run \`sudo tailscale up\`.`
    : status.userspaceNetworking === true
      ? "Tailscale sign-in needs device addresses, and userspace networking hides them. Give the container /dev/net/tun and run tailscaled without --tun=userspace-networking."
      : !isSupportedTailscaleVersion(status.version)
        ? `Tailscale ${status.version ?? "(unknown version)"} is too old for Tailscale sign-in. Update to ${MINIMUM_TAILSCALE_VERSION} or newer.`
        : null;

/**
 * Peers the tailnet policy grants T3 Code here, and whether this host is tagged. Null when
 * Tailscale cannot say, and "changed" when the account or its devices changed during the
 * check: lookups after a switch read another tailnet, and a device that joined was not read.
 */
const readPolicyGrantedPeers = readTailscaleStatus("active").pipe(
  Effect.flatMap((status) =>
    // Where sign-in cannot work, the policy does not matter, so no device is looked up.
    (signInBlocker(status) === null
      ? policyGrantedPeers(status, readTailscaleWhois)
      : Effect.succeed({ granted: [], unreadable: [] })
    ).pipe(
      Effect.flatMap((scan) =>
        readTailscaleStatus("active").pipe(
          Effect.map((after) =>
            after.selfNodeId !== status.selfNodeId ||
            (scan.granted.length === 0 && peersJoined(status, after))
              ? ("changed" as const)
              : {
                  ...scan,
                  tagged: status.selfTags.length > 0,
                  noNode: status.selfNodeId === null,
                  blocker: signInBlocker(status),
                },
          ),
        ),
      ),
    ),
  ),
  Effect.option,
  Effect.map(Option.getOrNull),
);

/** Whether this tagged host has an owner, from `t3 up --owner` or this shell's environment. */
const hasOwner = Effect.fn("cli.tailscale.hasOwner")(function* (
  baseDir: string,
  configured: string | undefined,
) {
  if (configured !== undefined) return true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(baseDir, SERVICE_ENV_FILE);
  return yield* fs.readFileString(file).pipe(
    Effect.map((text) => NodeUtil.parseEnv(text).T3CODE_TAILSCALE_OWNER !== undefined),
    Effect.orElseSucceed(() => false),
  );
});

const requireGrantCommand = Command.make("require-grant", {
  ...projectLocationFlags,
  state: Argument.Literals("state", ["on", "off"]).pipe(
    Argument.withDescription("Turn the requirement on or off. Without it, show the current state."),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription(
    `Show or change whether only devices your tailnet policy grants ${TAILNET_APP_CAPABILITY} sign in here.`,
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const file = path.join(config.stateDir, REQUIRE_GRANT_FILE);
      if (Option.contains(flags.state, "on")) {
        yield* turnOnRequireGrant(config.stateDir, "turned on with t3 tailscale require-grant");
      } else if (Option.contains(flags.state, "off")) {
        yield* fs.remove(file, { force: true });
      }
      const since = (yield* fs.exists(file)) ? (yield* fs.readFileString(file)).trim() : null;
      const read = yield* readPolicyGrantedPeers;
      const scan = read === "changed" ? null : read;
      const granted = scan?.granted ?? [];
      const lines =
        scan !== null && scan.blocker !== null
          ? [
              `No device signs in here. ${scan.blocker}`,
              since === null
                ? "The require-grant switch is off."
                : `Grant required: yes, turned on ${since}.`,
            ]
          : since !== null
            ? [
                `Grant required: yes, turned on ${since}.`,
                "Turn off with: t3 tailscale require-grant off",
              ]
            : granted.length > 0
              ? [
                  `Grant required: yes, because your tailnet policy grants ${TAILNET_APP_CAPABILITY} here to: ${granted.join(", ")}.`,
                  "Remove those grants to let your own untagged devices in without one.",
                ]
              : read === "changed"
                ? [
                    "Grant required: unknown. This host's Tailscale account or its devices",
                    "changed during the check.",
                    "Run this again.",
                  ]
                : scan === null
                  ? ["Grant required: yes, because Tailscale is not answering."]
                  : scan.noNode
                    ? [
                        "Grant required: yes, because Tailscale names no node for this host.",
                        "Run `tailscale up` to sign in.",
                      ]
                    : scan.unreadable.length > 0
                      ? [
                          `Grant required: probably. Tailscale could not read ${scan.unreadable.join(", ")},`,
                          "so T3 Code cannot tell whether your policy grants it here. It keeps the answer",
                          "from its last full check for up to five minutes, then requires a grant.",
                        ]
                      : scan.tagged &&
                          !(yield* hasOwner(config.baseDir, config.tailscaleOwnerUserId))
                        ? [
                            "Grant required: no, but this tagged host has no owner, so only granted",
                            "devices get in. Name its owner with: t3 up --owner <login>",
                          ]
                        : [
                            "Grant required: no. Your tailnet policy grants T3 Code here to no device,",
                            "so your own untagged devices sign in without one.",
                            `Once the policy grants ${TAILNET_APP_CAPABILITY} here, only granted devices get in.`,
                            "Require a grant now with: t3 tailscale require-grant on",
                          ];
      yield* Console.log(
        [
          ...lines,
          ...(scan?.blocker == null
            ? [
                "Devices with a grant get the scopes it names: read, standard, admin, or single scopes.",
              ]
            : []),
        ].join("\n"),
      );
    }),
  ),
);

export const tailscaleCommand = Command.make("tailscale").pipe(
  Command.withDescription("Check Tailscale on this machine, and who can sign in through it."),
  Command.withSubcommands([tailscaleStatusCommand, requireGrantCommand]),
);
