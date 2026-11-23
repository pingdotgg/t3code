# Rotate the PseudoCode signing credentials

A one-time repair. The current Developer ID private key was generated as a file by an agent, and its
passphrase and keychain password were typed on command lines, so both sit in plaintext in a Claude
Code transcript on this Mac.

The fix is to destroy every copy of that private key and issue a fresh certificate whose key is born
inside the macOS Keychain, where no command ever needs a password and nothing can be printed into a
transcript.

Budget 30 minutes. Do the steps in order; step 1 is the one that actually contains the problem.

## About revoking

Apple gives Developer ID certificates no Revoke button, on purpose. Revoking one would break every
app ever signed with it, so Apple handles it by email to Apple Product Security and reserves it for a
private key that genuinely escaped the machine.

You do not need it here. Deleting every copy of the key, which step 1 does, leaves the old
certificate unusable by anyone including you. An account may hold up to 5 Developer ID Application
certificates, so issuing a new one alongside the dead one is fine.

Email Apple Product Security only if you believe the key left this Mac, for example if `/tmp` or your
Claude transcripts were backed up or synced somewhere else. That is a judgment call about your own
machine, not something the code can answer.

## What each credential is

Three separate things, easy to confuse:

- **Developer ID Application certificate.** Signs the Mac app so macOS will run it. The private key
  is the part that matters; the `.cer` Apple gives back is public.
- **App Store Connect API key** (a `.p8` file, a key id, an issuer id). Lets `xcodebuild` and the
  upload tools act on your account. Used for iOS TestFlight uploads and for Mac notarization.
- **Keychain.** macOS's encrypted store. The login keychain unlocks with your Mac password when you
  log in, which is why keys belong there and not in a side keychain with its own password.

## 1. Destroy every copy of the old private key

Irreversible, and that is the point. Nothing has shipped signed with this key, so nothing breaks.

```sh
security delete-keychain ~/Library/Keychains/pseudocode-signing.keychain-db
rm -f /tmp/devid.key /tmp/devid.p12 /tmp/devid.pem /tmp/g2ca.pem
rm -f ~/Downloads/pseudocode-devid.csr ~/Downloads/developerID_application.cer
security list-keychains
```

The last command should no longer mention `pseudocode-signing`. The old certificate is now a dead
public record in your Apple account: no key, no signatures.

The transcript holding the old passphrase is at
`~/.claude/projects/-Users-chris--t3-worktrees-t3code-dev-t3code-b3588481/306238ca-3ba1-40d5-83a3-1c8a54c6ed9f.jsonl`.
It now unlocks nothing. Delete it if you want it gone anyway.

## 2. Create a new key pair in Keychain Access

This is the step that makes the difference. The key is born inside the keychain and never exists as
a file.

1. Open **Keychain Access** (Spotlight, type "Keychain Access").
2. Menu bar: **Keychain Access**, **Certificate Assistant**, **Request a Certificate From a
   Certificate Authority**.
3. Fill in:
   - **User Email Address**: `willdrumforfood05@yahoo.com`, the Apple ID on the developer account
   - **Common Name**: `Christopher Dodge`
   - **CA Email Address**: leave blank
   - **Request is**: select **Saved to disk**
   - Tick **Let me specify key pair information**
4. **Continue**. Save as `~/Downloads/PseudoCode.certSigningRequest`.
5. Next screen: **Key Size** 2048 bits, **Algorithm** RSA. **Continue**, then **Done**.

The private key is now in your login keychain. The `.certSigningRequest` is not secret; it is the
public half plus your name.

## 3. Get the certificate from Apple

1. developer.apple.com/account, **Certificates, Identifiers & Profiles**, **Certificates**, the
   **+** button.
2. Under **Software**, choose **Developer ID Application**. **Continue**.
3. Profile Type: **G2 Sub-CA (Xcode 11.4.1 or later)**. **Continue**.
4. Upload `~/Downloads/PseudoCode.certSigningRequest`. **Continue**.
5. **Download**. You get `developerID_application.cer`.

Leave the old certificate listed. It has no key behind it any more.

## 4. Install it

Double-click `developerID_application.cer`. Keychain Access files it under **login**, paired with the
private key from step 2.

Confirm:

```sh
security find-identity -v -p codesigning
```

Exactly one line should read `Developer ID Application: Christopher Dodge (PTQN7W6777)`. If two
appear, the old keychain survived step 1; re-run the delete. If Keychain Access shows the new one
under a keychain other than **login**, drag it to **login** and check again.

## 5. Keep the App Store Connect API key, and hide it behind a keychain profile

The `.p8` was never printed. Checked: the session that did the signing work contains zero private-key
headers, and every reference to the key is a path on a command line, never its contents. What the
transcript holds is the key id and the issuer id, which are identifiers and useless on their own.

So keep key `PPWXK32GH7`. Two things to do with it:

1. Confirm only you can read it:

   ```sh
   chmod 600 ~/.appstoreconnect/private_keys/AuthKey_PPWXK32GH7.p8
   ls -l ~/.appstoreconnect/private_keys/
   ```

   Expect `-rw-------`.

2. Save the notarization credential into the keychain, so no build command ever names the key
   again:

   ```sh
   xcrun notarytool store-credentials pseudocode \
     --key ~/.appstoreconnect/private_keys/AuthKey_PPWXK32GH7.p8 \
     --key-id PPWXK32GH7 \
     --issuer 126cdda4-2c8b-4e16-9931-56ee123495cb \
     --keychain "$HOME/Library/Keychains/login.keychain-db"
   ```

   Without `--keychain`, an agent shell prints "Credentials validated" and saves nothing; success
   also prints "Credentials saved to Keychain".

   From here on, notarization uses the profile name `pseudocode` and nothing else.

`.env.local` already carries `T3CODE_ASC_KEY_ID` and `T3CODE_ASC_ISSUER_ID` for the iOS upload, which
still needs the identifiers. Nothing to change there.

Replace this key only if the `.p8` file itself leaves the Mac. Then revoke it under
appstoreconnect.apple.com, **Users and Access**, **Integrations**, generate a new one with **Access:
Admin** (App Manager cannot create the distribution certificate, and `xcodebuild` reports that as
`Cloud signing permission error`), and redo both commands above with the new values.

## 6. Clean up the request file

```sh
rm -f ~/Downloads/PseudoCode.certSigningRequest ~/Downloads/developerID_application.cer
```

## 7. Prove it works

```sh
.agents/skills/ship-pseudocode/scripts/ship-mac.sh
```

It ends with `spctl` reporting `source=Notarized Developer ID`. That is the whole verification: the
app signs, notarizes, and passes Gatekeeper on a machine that did not build it.

## Why this cannot leak again

- The signing private key is generated by Keychain Access and never leaves the keychain. There is no
  file to read and no passphrase to type.
- Notarization runs off a keychain profile name. The key id, issuer id, and `.p8` path appear in no
  command.
- The only secret file left is the `.p8` at `~/.appstoreconnect/private_keys/`, mode 600. Apple's
  tools find it by key id on their own.
- `.claude/settings.json` denies agents from reading `~/.appstoreconnect` and `~/Library/Keychains`,
  and from running the commands that dump keychains or generate key files (`security dump-keychain`,
  `security export`, `openssl genrsa`, `openssl pkcs12`, and their neighbours).

If a second Mac or a CI runner ever needs to sign, adopt Fastlane Match rather than copying keys
around by hand. For one machine, the keychain is the right tool and Match is more moving parts than
the job needs.
