import { buildReferralShareMessage, REFERRAL_SHARE_TITLE } from "@t3tools/shared/referral";

type ShareReferral = (
  content: { readonly title: string; readonly message: string },
  options: { readonly dialogTitle: string; readonly subject: string },
) => Promise<unknown>;

export async function shareReferralLink(referralLink: string, share: ShareReferral): Promise<void> {
  if (!referralLink) return;
  try {
    await share(
      {
        title: REFERRAL_SHARE_TITLE,
        message: buildReferralShareMessage(referralLink),
      },
      {
        dialogTitle: "Share referral link",
        subject: REFERRAL_SHARE_TITLE,
      },
    );
  } catch {}
}
