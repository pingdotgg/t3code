import * as kendra from "@distilled.cloud/aws/kendra";
import { toWireDays } from "alchemy/Util/Duration";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import type { UpdateQuerySuggestionsConfigRequest } from "./UpdateQuerySuggestionsConfig.ts";
import { UpdateQuerySuggestionsConfig } from "./UpdateQuerySuggestionsConfig.ts";

export const UpdateQuerySuggestionsConfigHttp = Layer.effect(
  UpdateQuerySuggestionsConfig,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.UpdateQuerySuggestionsConfig",
    operation: kendra.updateQuerySuggestionsConfig,
    actions: ["kendra:UpdateQuerySuggestionsConfig"],
    prepare: ({ queryLogLookBackWindow, ...rest }: UpdateQuerySuggestionsConfigRequest = {}) => ({
      ...rest,
      QueryLogLookBackWindowInDays: toWireDays(queryLogLookBackWindow),
    }),
  }),
);
