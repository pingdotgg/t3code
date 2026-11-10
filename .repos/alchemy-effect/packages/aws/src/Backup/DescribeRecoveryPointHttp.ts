import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupVaultHttpBinding } from "./BindingHttp.ts";
import { DescribeRecoveryPoint } from "./DescribeRecoveryPoint.ts";

export const DescribeRecoveryPointHttp = Layer.effect(
  DescribeRecoveryPoint,
  makeBackupVaultHttpBinding({
    tag: "AWS.Backup.DescribeRecoveryPoint",
    operation: backup.describeRecoveryPoint,
    actions: ["backup:DescribeRecoveryPoint"],
    // Recovery-point actions authorize on the recovery point ARN (the
    // underlying resource's snapshot ARN), not the vault ARN.
    wildcardIam: true,
  }),
);
