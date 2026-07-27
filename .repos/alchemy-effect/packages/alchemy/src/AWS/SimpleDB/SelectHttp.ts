import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { registerSimpleDbBinding } from "./Binding.ts";
import type { Domain } from "./Domain.ts";
import { Select, type SelectRequest } from "./Select.ts";

export const SelectHttp = Layer.effect(
  Select,
  Effect.gen(function* () {
    const select = yield* sdb.select;

    return Effect.fn(function* (domain: Domain) {
      const domainName = yield* domain.domainName;
      yield* registerSimpleDbBinding("Select", domain);
      return Effect.fn(`AWS.SimpleDB.Select(${domain.LogicalId})`)(function* (
        request: SelectRequest,
      ) {
        const { SelectExpression, ...rest } = request;
        const name = yield* domainName;
        return yield* select({
          ...rest,
          SelectExpression:
            typeof SelectExpression === "function"
              ? SelectExpression(name)
              : SelectExpression,
        });
      });
    });
  }),
);
