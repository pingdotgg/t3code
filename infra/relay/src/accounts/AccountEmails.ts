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

Your data on our systems: everything associated with your account will be deleted within 30 days.

On your devices: threads, projects and settings stored on your devices stay where they are. To remove them, uninstall T3 Code or delete its data folder.

Didn't delete your account, or have a question? Reply to this email or write to ${ACCOUNT_EMAIL_REPLY_TO}.

T3 Tools, Inc. · https://t3.codes`;

// Hosted by the marketing site; email clients don't render SVG or inline images reliably.
const BRAND_ICON_URL = "https://t3.codes/apple-touch-icon.png";
const SANS = "-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif";

const deletionNoticeHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>Your T3 Code account has been deleted</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:${SANS};color:#0a0a0a;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;">All data associated with your account will be deleted within 30 days.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
            <tr>
              <td style="background:#000000;border-radius:16px 16px 0 0;padding:20px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:middle;padding-right:10px;">
                      <img src="${BRAND_ICON_URL}" width="32" height="32" alt="T3" style="display:block;width:32px;height:32px;border:0;border-radius:8px;color:#f5f5f5;font-weight:700;font-size:16px;" />
                    </td>
                    <td style="vertical-align:middle;font-size:17px;font-weight:500;letter-spacing:-0.02em;color:#a3a3a3;">Code</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;border:1px solid #e4e4e7;border-top:0;border-radius:0 0 16px 16px;padding:36px 32px 32px;">
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:#0a0a0a;">Your account has been deleted</h1>
                <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#3f3f46;">We've deleted your T3 Code account. Here is what happens next.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:12px;">
                  <tr>
                    <td style="padding:18px 20px;border-bottom:1px solid #e4e4e7;">
                      <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#71717a;">Your data on our systems</p>
                      <p style="margin:0;font-size:15px;line-height:1.55;color:#0a0a0a;">Everything associated with your account will be deleted within <strong style="white-space:nowrap;">30 days</strong>.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#71717a;">On your devices</p>
                      <p style="margin:0;font-size:15px;line-height:1.55;color:#0a0a0a;">Threads, projects and settings stored on your devices stay where they are. To remove them, uninstall T3 Code or delete its data folder.</p>
                    </td>
                  </tr>
                </table>
                <p style="margin:28px 0 0;font-size:14px;line-height:1.6;color:#52525b;">Didn't delete your account, or have a question? Reply to this email or write to <a href="mailto:${ACCOUNT_EMAIL_REPLY_TO}" style="color:#2f5bc2;text-decoration:underline;">${ACCOUNT_EMAIL_REPLY_TO}</a>.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#a1a1aa;">
                T3 Tools, Inc. &middot; <a href="https://t3.codes" style="color:#a1a1aa;text-decoration:underline;">t3.codes</a><br />
                You received this because a T3 Code account using this address was deleted.
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
