import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeTransferServerHttpBinding } from "./BindingHttp.ts";
import { TestIdentityProvider } from "./TestIdentityProvider.ts";

export const TestIdentityProviderHttp = Layer.effect(
  TestIdentityProvider,
  makeTransferServerHttpBinding({
    tag: "AWS.Transfer.TestIdentityProvider",
    operation: transfer.testIdentityProvider,
    actions: ["transfer:TestIdentityProvider"],
    // AWS authorizes this operation against the addressed user, despite the
    // binding being server-scoped so it can inject ServerId. UserName arrives
    // at runtime, so grant the operation on every user of the bound server.
    resource: (server) =>
      Output.map(server.arn, (arn) => `${arn.replace(":server/", ":user/")}/*`),
  }),
);
