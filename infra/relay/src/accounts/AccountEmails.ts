import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const ACCOUNT_EMAIL_REPLY_TO = "privacy@t3.tools";

export const accountEmailSender = (relayApiZoneName: string) => ({
  domain: `mail.${relayApiZoneName}`,
  address: `noreply@mail.${relayApiZoneName}`,
});

export class AccountEmailFailed extends Schema.TaggedError<AccountEmailFailed>()(
  "AccountEmailFailed",
  { cause: Schema.Defect() },
) {}

export interface AccountEmailMessage {
  readonly from: { readonly email: string; readonly name: string };
  readonly to: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const deletionNoticeText = `Your T3 Code account has been deleted.

Our systems: we've deleted your T3 Connect account, linked environments and tunnels, and registered phones and notification settings. Usage data and logs linked to your account, and our backups, are deleted within 30 days.

Your devices: uninstalling T3 Code doesn't remove its data from your computer. To remove your threads, projects and settings, uninstall the app and delete the .t3 folder in your home folder. On a phone, deleting the app removes its data.

Didn't delete your account, or have a question? Reply to this email or write to ${ACCOUNT_EMAIL_REPLY_TO}.

T3 Tools, Inc. · https://t3.codes`;

// Hosted by the marketing site; email clients don't render SVG or inline images reliably.
const BRAND_ICON_URL = "https://t3.codes/apple-touch-icon.png";
const SANS = "-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif";

// Dark palette and outro-card styling from the launch-video kit (apps/web dark theme).
const deletionNoticeHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>Your T3 Code account has been deleted</title>
  </head>
  <body style="margin:0;padding:0;background:#000000;font-family:${SANS};color:#f1f3f7;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;">Your T3 Connect account is deleted. Usage data, logs and backups follow within 30 days.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;">
      <tr>
        <td align="center" style="padding:0 16px;background:#000000;background-image:radial-gradient(520px 320px at 50% 0%, rgba(52,107,241,0.22), rgba(0,0,0,0) 70%);">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
            <tr>
              <td align="center" style="padding:56px 0 0;">
                <img src="${BRAND_ICON_URL}" width="64" height="64" alt="T3" style="display:block;width:64px;height:64px;border:1px solid rgba(255,255,255,0.14);border-radius:14px;color:#f1f3f7;font-weight:700;font-size:20px;" />
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:32px 0 0;">
                <h1 style="margin:0;font-size:34px;line-height:1.08;font-weight:760;letter-spacing:-0.04em;color:#f1f3f7;">Your account<br /><span style="color:#a3a3a3;">has been deleted</span></h1>
                <p style="margin:18px 0 0;font-size:16px;line-height:1.55;color:#a3a3a3;">Here's what happens next.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:40px 0 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e0f;border:1px solid #1d1d20;border-radius:16px;">
                  <tr>
                    <td style="padding:22px 24px;border-bottom:1px solid #1d1d20;">
                      <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#6e9bfb;">Our systems</p>
                      <p style="margin:0;font-size:15px;line-height:1.6;color:#f1f3f7;">We've deleted your T3 Connect account, linked environments and tunnels, and registered phones and notification settings.</p>
                      <p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#a3a3a3;">Usage data and logs linked to your account, and our backups, are deleted within <span style="white-space:nowrap;font-weight:650;color:#f1f3f7;">30 days</span>.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:22px 24px;">
                      <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#6e9bfb;">Your devices</p>
                      <p style="margin:0;font-size:15px;line-height:1.6;color:#f1f3f7;">Uninstalling T3 Code doesn't remove its data from your computer. To remove your threads, projects and settings, uninstall the app <strong style="font-weight:650;">and</strong> delete the <span style="white-space:nowrap;font-weight:650;">.t3</span> folder in your home folder.</p>
                      <p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#a3a3a3;">On a phone, deleting the app removes its data.</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:32px 8px 0;">
                <p style="margin:0;font-size:14px;line-height:1.6;color:#a3a3a3;">Didn't delete your account, or have a question?<br />Reply to this email or write to <a href="mailto:${ACCOUNT_EMAIL_REPLY_TO}" style="color:#6e9bfb;text-decoration:none;">${ACCOUNT_EMAIL_REPLY_TO}</a>.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:48px 0 48px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1d1d20;">
                  <tr>
                    <td style="padding:20px 0 0;font-size:13px;line-height:1.6;color:#8e8e93;">
                      <a href="https://t3.codes" style="color:#8e8e93;text-decoration:none;"><img src="${BRAND_ICON_URL}" width="16" height="16" alt="" style="display:inline-block;width:16px;height:16px;border:0;border-radius:4px;vertical-align:-3px;margin-right:8px;" />T3 Tools Inc</a>
                    </td>
                    <td align="right" style="padding:20px 0 0;font-size:13px;line-height:1.6;white-space:nowrap;">
                      <a href="https://t3.codes/privacy-policy" style="color:#8e8e93;text-decoration:none;">Privacy</a><span style="color:#3f3f46;">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span><a href="https://t3.codes/terms-of-service" style="color:#8e8e93;text-decoration:none;">Terms</a>
                    </td>
                  </tr>
                  <tr>
                    <td colspan="2" style="padding:6px 0 0;font-size:12px;line-height:1.6;color:#636368;">Sent because a T3 Code account using this address was deleted.</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

export const deletionNotice = (input: { readonly from: string; readonly to: string }) =>
  ({
    from: { email: input.from, name: "T3 Code" },
    to: input.to,
    replyTo: ACCOUNT_EMAIL_REPLY_TO,
    subject: "Your T3 Code account has been deleted",
    text: deletionNoticeText,
    html: deletionNoticeHtml,
  }) satisfies AccountEmailMessage;

export class AccountEmails extends Context.Service<
  AccountEmails,
  {
    readonly sendDeletionNotice: (input: {
      readonly to: string;
    }) => Effect.Effect<void, AccountEmailFailed>;
  }
>()("t3code-relay/accounts/AccountEmails") {}

export const layer = (options: {
  readonly from: string;
  readonly send: (message: AccountEmailMessage) => Effect.Effect<unknown, Error>;
}) =>
  Layer.succeed(AccountEmails, {
    sendDeletionNotice: Effect.fn("relay.account_emails.send_deletion_notice")(function* ({ to }) {
      yield* options
        .send(deletionNotice({ from: options.from, to }))
        .pipe(Effect.mapError((cause) => new AccountEmailFailed({ cause })));
    }),
  });
