import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueCrawlerHttpBinding } from "./BindingHttp.ts";
import { StartCrawler } from "./StartCrawler.ts";

export const StartCrawlerHttp = Layer.effect(
  StartCrawler,
  makeGlueCrawlerHttpBinding({
    tag: "AWS.Glue.StartCrawler",
    operation: glue.startCrawler,
    actions: ["glue:StartCrawler"],
  }),
);
