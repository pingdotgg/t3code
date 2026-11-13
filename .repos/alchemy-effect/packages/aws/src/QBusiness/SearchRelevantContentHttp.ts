import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { SearchRelevantContent } from "./SearchRelevantContent.ts";

export const SearchRelevantContentHttp = Layer.effect(
  SearchRelevantContent,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.SearchRelevantContent",
    operation: qbusiness.searchRelevantContent,
    actions: ["qbusiness:SearchRelevantContent"],
    subResources: ["retriever/*"],
  }),
);
