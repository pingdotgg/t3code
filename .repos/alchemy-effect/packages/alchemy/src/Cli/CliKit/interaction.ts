import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Interaction } from "../../Interaction.ts";
import { CliKit } from "./CliKit.ts";

/**
 * The CLI's implementation of the engine's {@link Interaction} capability,
 * backed by the full CliKit terminal runtime: messages and `task` render
 * through the live renderer, prompts run as real interactive screens.
 * Provided by the CLI entrypoints next to `CliKit.layer()`; every other
 * process uses `Interaction.layerNonInteractive` (or nothing at all —
 * children have no interaction capability in their graphs).
 */
export const CliKitInteraction = Layer.effect(
  Interaction,
  // CliKit's surface is a structural superset of Interaction's — the
  // terminal service IS the CLI's Interaction implementation.
  Effect.map(CliKit, (cli): Interaction["Service"] => cli),
);
