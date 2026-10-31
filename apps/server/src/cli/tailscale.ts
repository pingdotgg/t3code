import * as NodeUtil from "node:util";

import { ServerTailscaleStatus, TAILNET_APP_CAPABILITY } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { readTailscaleStatus, readTailscaleWhois } from "@t3tools/tailscale";
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
import { policyGrantedPeers } from "../auth/tailnetGrants.ts";
import { formatTailscaleHealth, readTailscaleHealth } from "../environment/TailscaleHealth.ts";
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

/** Peers the tailnet policy grants T3 Code here, and whether this host is tagged. Null when Tailscale cannot say. */
const readPolicyGrantedPeers = readTailscaleStatus("active").pipe(
  Effect.flatMap((status) =>
    policyGrantedPeers(status, readTailscaleWhois).pipe(
      Effect.map((scan) => ({ ...scan, tagged: status.selfTags.length > 0 })),
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
      const scan = yield* readPolicyGrantedPeers;
      const granted = scan?.granted ?? [];
      const lines =
        since !== null
          ? [
              `Grant required: yes, turned on ${since}.`,
              "Turn off with: t3 tailscale require-grant off",
            ]
          : granted.length > 0
            ? [
                `Grant required: yes, because your tailnet policy grants ${TAILNET_APP_CAPABILITY} here to: ${granted.join(", ")}.`,
                "Remove those grants to let your own untagged devices in without one.",
              ]
            : scan === null
              ? ["Grant required: yes, because Tailscale is not answering."]
              : scan.unreadable.length > 0
                ? [
                    `Grant required: probably. Tailscale could not read ${scan.unreadable.join(", ")},`,
                    "so T3 Code cannot tell whether your policy grants it here. It keeps the answer",
                    "from its last full check for up to five minutes, then requires a grant.",
                  ]
                : scan.tagged && !(yield* hasOwner(config.baseDir, config.tailscaleOwnerUserId))
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
          "Devices with a grant get the scopes it names: read, standard, admin, or single scopes.",
        ].join("\n"),
      );
    }),
  ),
);

export const tailscaleCommand = Command.make("tailscale").pipe(
  Command.withDescription("Check Tailscale on this machine, and who can sign in through it."),
  Command.withSubcommands([tailscaleStatusCommand, requireGrantCommand]),
);
