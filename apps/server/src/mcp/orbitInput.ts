import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The broker is off, with no tool and no provider policy change, unless this names a file. */
export const orbitBrokerTokenFile = Config.option(
  Config.String("T3CODE_ORBIT_BROKER_TOKEN_FILE"),
).pipe(Config.map(Option.filter((path) => path.trim().length > 0)));

/**
 * Codex attests each call through its host callback and Claude's SDK hook narrows native children.
 * Other adapters have neither, so a native child would hold its parent's write access.
 */
export const orbitCredentialPolicy = (brokerEnabled: boolean, driver: string | undefined) => ({
  orbitNeedsAttestation: brokerEnabled && (driver === undefined || driver === "codex"),
  orbitContextOnly:
    brokerEnabled && driver !== undefined && driver !== "codex" && driver !== "claudeAgent",
});

export const Operation = Schema.Literals([
  "orbit_context",
  "project_list",
  "ticket_list",
  "ticket_get",
  "ticket_create",
  "ticket_update",
  "ticket_link_thread",
  "create_ticket",
  "start_thread",
]);
export const Input = Schema.Struct({
  operation: Operation,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
