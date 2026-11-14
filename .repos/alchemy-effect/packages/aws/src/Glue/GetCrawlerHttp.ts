import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueCrawlerHttpBinding } from "./BindingHttp.ts";
import { GetCrawler } from "./GetCrawler.ts";

export const GetCrawlerHttp = Layer.effect(
  GetCrawler,
  makeGlueCrawlerHttpBinding({
    tag: "AWS.Glue.GetCrawler",
    operation: glue.getCrawler,
    actions: ["glue:GetCrawler"],
  }),
);
