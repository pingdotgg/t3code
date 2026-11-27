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

All data associated with your account will be deleted from our systems within 30 days.

Threads, projects and settings stored on your own devices are not affected. To remove them, uninstall T3 Code or delete its data folder.

If you didn't delete your account, or have any questions, reply to this email or write to ${ACCOUNT_EMAIL_REPLY_TO}.

T3 Code`;

const deletionNoticeHtml = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px 16px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#16191f;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #dde1e7;border-radius:10px;">
            <tr>
              <td style="padding:32px;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 20px;font-size:20px;font-weight:600;">Your T3 Code account has been deleted</p>
                <p style="margin:0 0 16px;">All data associated with your account will be deleted from our systems within 30 days.</p>
                <p style="margin:0 0 16px;">Threads, projects and settings stored on your own devices are not affected. To remove them, uninstall T3 Code or delete its data folder.</p>
                <p style="margin:0;color:#59606d;">If you didn't delete your account, or have any questions, reply to this email or write to <a href="mailto:${ACCOUNT_EMAIL_REPLY_TO}" style="color:#1f5f73;">${ACCOUNT_EMAIL_REPLY_TO}</a>.</p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#59606d;">T3 Code</p>
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
