import * as contacts from "@distilled.cloud/aws/ssm-contacts";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface PlanProps {
  /**
   * The ARN of the contact or escalation plan whose engagement plan this
   * resource manages. Changing it replaces the plan.
   */
  contactId: string;

  /**
   * The stages that Incident Manager runs through when engaging the contact:
   * each stage has a duration and a set of channel/contact targets.
   */
  stages?: contacts.Stage[];

  /**
   * ARNs of the on-call rotations associated with the plan (only valid for
   * `ONCALL_SCHEDULE` contacts).
   */
  rotationIds?: string[];
}

/** @resource */
export interface Plan extends Resource<
  "AWS.SSMContacts.Plan",
  PlanProps,
  {
    /** ARN of the contact whose engagement plan is managed. */
    contactArn: string;
    /** Number of stages in the plan. */
    stageCount: number;
  },
  never,
  Providers
> {}

/**
 * The engagement plan of an Incident Manager contact — the staged sequence
 * of contact channels (for `PERSONAL` contacts), contacts (for `ESCALATION`
 * plans), or rotations (for `ONCALL_SCHEDULE` contacts) that Incident
 * Manager engages during an incident.
 *
 * Manage a contact's plan either inline via the `plan` prop on
 * `SSMContacts.Contact` or standalone with this resource — not both.
 * Deleting this resource resets the contact's plan to empty.
 *
 * @section Managing Engagement Plans
 * @example Engage an email channel for 5 minutes
 * ```typescript
 * const plan = yield* SSMContacts.Plan("OncallPlan", {
 *   contactId: oncall.contactArn,
 *   stages: [
 *     {
 *       DurationInMinutes: 5,
 *       Targets: [
 *         {
 *           ChannelTargetInfo: {
 *             ContactChannelId: email.contactChannelArn,
 *             RetryIntervalInMinutes: 1,
 *           },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
const PlanResource = Resource<Plan>("AWS.SSMContacts.Plan");

export { PlanResource as Plan };

export const PlanProvider = () =>
  Provider.effect(
    PlanResource,
    Effect.gen(function* () {
      const getContact = (arn: string) =>
        contacts
          .getContact({ ContactId: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const buildAttrs = (contact: contacts.GetContactResult) => ({
        contactArn: contact.ContactArn,
        stageCount: contact.Plan.Stages?.length ?? 0,
      });

      return PlanResource.Provider.of({
        stables: ["contactArn"],

        // Settings sub-resource of a contact — nothing to enumerate.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const arn = output?.contactArn ?? olds?.contactId;
          if (arn === undefined) return undefined;
          const contact = yield* getContact(arn);
          if (contact === undefined) return undefined;
          // The plan is a setting on the contact, not a distinct cloud
          // object — it "exists" when the contact has stages or rotations.
          const hasPlan =
            (contact.Plan.Stages?.length ?? 0) > 0 ||
            (contact.Plan.RotationIds?.length ?? 0) > 0;
          return hasPlan ? buildAttrs(contact) : undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.contactId !== news.contactId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // 1. OBSERVE — the contact is authoritative for its current plan.
          const contact = yield* contacts.getContact({
            ContactId: news.contactId,
          });

          // 2/3. SYNC — apply the desired plan when it differs from the
          //      observed one (updateContact fully replaces the plan).
          const desired: contacts.Plan = {
            Stages: news.stages ?? [],
            ...(news.rotationIds !== undefined
              ? { RotationIds: news.rotationIds }
              : {}),
          };
          const observed: contacts.Plan = {
            Stages: contact.Plan.Stages ?? [],
            ...(contact.Plan.RotationIds !== undefined
              ? { RotationIds: contact.Plan.RotationIds }
              : {}),
          };
          if (JSON.stringify(desired) !== JSON.stringify(observed)) {
            yield* contacts.updateContact({
              ContactId: contact.ContactArn,
              Plan: desired,
            });
          }

          // 4. RETURN fresh attributes.
          const final = yield* contacts.getContact({
            ContactId: news.contactId,
          });
          yield* session.note(final.ContactArn);
          return buildAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Deleting the plan resets the contact's engagement plan. A
          // vanished contact means there is nothing left to reset.
          yield* contacts
            .updateContact({
              ContactId: output.contactArn,
              Plan: { Stages: [] },
            })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
