import * as Layer from "effect/Layer";
import { makeWriteTopicBinding } from "./AccessHttp.ts";
import { WriteTopic } from "./WriteTopic.ts";

/**
 * HTTP implementation of {@link WriteTopic} over the Pub/Sub REST API.
 *
 * @layer
 * @provides GCP.PubSub.WriteTopic
 * @category PubSub
 */
export const WriteTopicHttp = Layer.effect(WriteTopic, makeWriteTopicBinding);
