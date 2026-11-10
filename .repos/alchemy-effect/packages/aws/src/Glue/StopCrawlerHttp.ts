import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueCrawlerHttpBinding } from "./BindingHttp.ts";
import { StopCrawler } from "./StopCrawler.ts";

export const StopCrawlerHttp = Layer.effect(
  StopCrawler,
  makeGlueCrawlerHttpBinding({
    tag: "AWS.Glue.StopCrawler",
    operation: glue.stopCrawler,
    actions: ["glue:StopCrawler"],
  }),
);
