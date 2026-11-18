import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ResetEncryptionKey } from "./ResetEncryptionKey.ts";

export const ResetEncryptionKeyHttp = Layer.effect(
  ResetEncryptionKey,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ResetEncryptionKey",
    operation: inspector2.resetEncryptionKey,
    actions: ["inspector2:ResetEncryptionKey"],
  }),
);
