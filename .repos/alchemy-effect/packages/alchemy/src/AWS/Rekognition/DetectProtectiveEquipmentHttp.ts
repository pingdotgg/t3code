import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DetectProtectiveEquipment } from "./DetectProtectiveEquipment.ts";

export const DetectProtectiveEquipmentHttp = Layer.effect(
  DetectProtectiveEquipment,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DetectProtectiveEquipment",
    operation: rekognition.detectProtectiveEquipment,
    actions: ["rekognition:DetectProtectiveEquipment"],
  }),
);
