import * as GCP from "@/GCP";

/** Resources the bound-service fixtures share across deploy steps. */
export const Tweets = GCP.PubSub.Topic("tweets", {});
export const DataBucket = GCP.Storage.Bucket("data", { forceDestroy: true });
