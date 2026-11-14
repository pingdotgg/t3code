import * as Schema from "effect/Schema";
import { CustomerId } from "./Customer/Customer.id.ts";

/**
 * Who is acting. `Session` provides it as the `CurrentActor` of each
 * request; events that need an audit trail record it as `by`.
 */
export const Actor = Schema.Union([
  Schema.TaggedStruct("Customer", { customerId: CustomerId }),
  Schema.TaggedStruct("Agent", { agentId: Schema.String }),
  Schema.TaggedStruct("System", { name: Schema.String }),
]);
export type Actor = typeof Actor.Type;

export const customer = (customerId: string): Actor => ({
  _tag: "Customer",
  customerId: CustomerId.make(customerId),
});
export const agent = (agentId: string): Actor => ({ _tag: "Agent", agentId });
export const system = (name: string): Actor => ({ _tag: "System", name });
