import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { GetEncryptionKey } from "./GetEncryptionKey.ts";

export const GetEncryptionKeyHttp = Layer.effect(
  GetEncryptionKey,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetEncryptionKey",
    operation: inspector2.getEncryptionKey,
    actions: ["inspector2:GetEncryptionKey"],
  }),
);
