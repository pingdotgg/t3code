import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { UpdateEncryptionKey } from "./UpdateEncryptionKey.ts";

export const UpdateEncryptionKeyHttp = Layer.effect(
  UpdateEncryptionKey,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.UpdateEncryptionKey",
    operation: inspector2.updateEncryptionKey,
    actions: ["inspector2:UpdateEncryptionKey"],
  }),
);
