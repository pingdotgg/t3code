import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import { toRedactedBytes, toTagRecord } from "./common.ts";

export interface VirtualMFADeviceProps {
  /**
   * Name of the virtual MFA device. If omitted, a deterministic name is generated.
   */
  virtualMFADeviceName?: string;
  /**
   * Optional IAM path prefix.
   * @default "/"
   */
  path?: string;
  /**
   * Optional user to activate the device for.
   */
  userName?: string;
  /**
   * First authentication code used when activating the device.
   */
  authenticationCode1?: string;
  /**
   * Second authentication code used when activating the device.
   */
  authenticationCode2?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface VirtualMFADevice extends Resource<
  "AWS.IAM.VirtualMFADevice",
  VirtualMFADeviceProps,
  {
    serialNumber: string;
    userName: string | undefined;
    enableDate: Date | undefined;
    base32StringSeed:
      | Redacted.Redacted<Uint8Array<ArrayBufferLike>>
      | undefined;
    qrCodePNG: Redacted.Redacted<Uint8Array<ArrayBufferLike>> | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IAM virtual MFA device.
 *
 * `VirtualMFADevice` creates a software MFA device and can optionally activate
 * it for a user during creation when the initial authentication codes are
 * provided.
 *
 * @section Managing MFA Devices
 * @example Create and Activate a Virtual MFA Device
 * ```typescript
 * const user = yield* User("AdminUser", {
 *   userName: "admin-user",
 * });
 *
 * const device = yield* VirtualMFADevice("AdminMfa", {
 *   userName: user.userName,
 *   authenticationCode1: "123456",
 *   authenticationCode2: "654321",
 * });
 * ```
 */
export const VirtualMFADevice = Resource<VirtualMFADevice>(
  "AWS.IAM.VirtualMFADevice",
);

export const VirtualMFADeviceProvider = () =>
  Provider.effect(
    VirtualMFADevice,
    Effect.gen(function* () {
      const toName = (id: string, props: VirtualMFADeviceProps) =>
        props.virtualMFADeviceName
          ? Effect.succeed(props.virtualMFADeviceName)
          : createPhysicalName({ id, maxLength: 226 });

      const readDevice = Effect.fn(function* ({
        serialNumber,
        userName,
      }: {
        serialNumber: string;
        userName: string | undefined;
      }) {
        if (!userName) {
          const listed = yield* iam.listVirtualMFADevices({
            AssignmentStatus: "Unassigned",
          });
          const device = listed.VirtualMFADevices.find(
            (entry) => entry.SerialNumber === serialNumber,
          );
          return device
            ? {
                SerialNumber: device.SerialNumber,
                UserName: device.User?.UserName,
                EnableDate: device.EnableDate,
              }
            : undefined;
        }
        return yield* iam
          .getMFADevice({
            SerialNumber: serialNumber,
            UserName: userName,
          })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["serialNumber"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? ({} as VirtualMFADeviceProps))) !==
              (yield* toName(id, news)) ||
            (olds.path ?? "/") !== (news.path ?? "/") ||
            (olds.userName ?? undefined) !== (news.userName ?? undefined) ||
            (olds.authenticationCode1 ?? undefined) !==
              (news.authenticationCode1 ?? undefined) ||
            (olds.authenticationCode2 ?? undefined) !==
              (news.authenticationCode2 ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) {
            return undefined;
          }
          const response = yield* readDevice({
            serialNumber: output.serialNumber,
            userName: output.userName,
          });
          if (!response?.SerialNumber) {
            return undefined;
          }
          const tags = yield* iam.listMFADeviceTags({
            SerialNumber: output.serialNumber,
          });
          return {
            serialNumber: response.SerialNumber,
            userName: response.UserName ?? output.userName,
            enableDate: response.EnableDate,
            base32StringSeed: output.base32StringSeed,
            qrCodePNG: output.qrCodePNG,
            tags: toTagRecord(tags.Tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — virtual MFA devices have AWS-generated serial
          // numbers, so we can only locate the existing device when we
          // already have its serial from a prior output.
          const observed = output
            ? yield* readDevice({
                serialNumber: output.serialNumber,
                userName: output.userName,
              })
            : undefined;

          // Ensure — create the device when missing. The seed and QR
          // code are only returned on creation, so on adoption the best
          // we can do is preserve the existing redacted values.
          let serialNumber = observed?.SerialNumber ?? output?.serialNumber;
          let base32StringSeed = output?.base32StringSeed;
          let qrCodePNG = output?.qrCodePNG;

          if (!observed?.SerialNumber) {
            const deviceName = yield* toName(id, news);
            const created = yield* iam.createVirtualMFADevice({
              Path: news.path,
              VirtualMFADeviceName: deviceName,
              Tags: createTagsList(desiredTags),
            });
            if (!created.VirtualMFADevice.SerialNumber) {
              return yield* Effect.fail(
                new Error(`createVirtualMFADevice returned no serial number`),
              );
            }
            serialNumber = created.VirtualMFADevice.SerialNumber;
            base32StringSeed = toRedactedBytes(
              created.VirtualMFADevice.Base32StringSeed,
            );
            qrCodePNG = toRedactedBytes(created.VirtualMFADevice.QRCodePNG);

            // The device was just created, so it is unassigned. Activate
            // it for the user when activation codes are provided. After
            // first activation the codes lose their meaning (`diff`
            // triggers replacement on code change).
            if (
              news.userName &&
              news.authenticationCode1 &&
              news.authenticationCode2
            ) {
              yield* iam.enableMFADevice({
                UserName: news.userName,
                SerialNumber: serialNumber,
                AuthenticationCode1: news.authenticationCode1,
                AuthenticationCode2: news.authenticationCode2,
              });
            }
          }

          if (!serialNumber) {
            return yield* Effect.fail(
              new Error(`Virtual MFA device has no serial number`),
            );
          }

          // Sync tags against the cloud's actual tags.
          const observedTagsResp = yield* iam.listMFADeviceTags({
            SerialNumber: serialNumber,
          });
          const observedTags = toTagRecord(observedTagsResp.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* iam.tagMFADevice({
              SerialNumber: serialNumber,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagMFADevice({
              SerialNumber: serialNumber,
              TagKeys: removed,
            });
          }

          // Re-read for fresh `EnableDate` / `UserName` after activation.
          const fresh = yield* readDevice({
            serialNumber,
            userName: news.userName ?? output?.userName,
          });

          yield* session.note(serialNumber);
          return {
            serialNumber,
            userName: fresh?.UserName ?? news.userName ?? output?.userName,
            enableDate: fresh?.EnableDate ?? output?.enableDate,
            base32StringSeed,
            qrCodePNG,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.userName) {
            yield* iam
              .deactivateMFADevice({
                UserName: output.userName,
                SerialNumber: output.serialNumber,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
          yield* iam
            .deleteVirtualMFADevice({
              SerialNumber: output.serialNumber,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
