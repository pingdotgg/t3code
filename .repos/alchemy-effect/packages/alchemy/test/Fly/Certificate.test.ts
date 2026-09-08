import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const CUSTOM_HOSTNAME = "alchemy-fly-cert-1.example.com";
const REPLACE_HOSTNAME = "alchemy-fly-cert-2.example.com";

/**
 * Self-signed RSA-2048 certificates generated once with openssl and checked
 * in so every test run uploads identical PEMs (never generated at test time):
 *
 * ```sh
 * openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
 *   -days 3650 -subj "/CN=alchemy-fly-cert-1.example.com/O=Alchemy/C=US" \
 *   -addext "subjectAltName=DNS:alchemy-fly-cert-1.example.com"
 * ```
 */
const CERT_1A = `-----BEGIN CERTIFICATE-----
MIIDQDCCAiigAwIBAgIJALfOoslKUT5HMA0GCSqGSIb3DQEBCwUAMEgxJzAlBgNV
BAMMHmFsY2hlbXktZmx5LWNlcnQtMS5leGFtcGxlLmNvbTEQMA4GA1UECgwHQWxj
aGVteTELMAkGA1UEBhMCVVMwHhcNMjYwODE5MDczMzA4WhcNMzYwODE2MDczMzA4
WjBIMScwJQYDVQQDDB5hbGNoZW15LWZseS1jZXJ0LTEuZXhhbXBsZS5jb20xEDAO
BgNVBAoMB0FsY2hlbXkxCzAJBgNVBAYTAlVTMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAw94Wjab6qnzkDDoZgnzKUSoszHvkO4oTRio+dLHWaN6T1nCe
YaoWlzjBVzSnpyHlKmCjzyYlLFbWdNxuyeqr8js0/pfQSCDAJetvWJCwHqcDxYV9
fOxjNcbRyK22HcQW/iaqDFBmTb9HPp2zyH7smuFDgS6zEFWintoRtkizqAhdkl3c
hI9soUK5jVoOK9f9xRbGMGf8JBuBevmzdZ2kosp346FuV3XCxzsvVcx3ub+QN0Gg
K2MGW+c5gwGmltOmycdMpATIwrv7RtVH51cEjLHVGnySlMnmITDdtMnd2dlMjShe
hBcR/Wn49iGz5y6mMz1s5NN7TjtzmmYJcx3sCQIDAQABoy0wKzApBgNVHREEIjAg
gh5hbGNoZW15LWZseS1jZXJ0LTEuZXhhbXBsZS5jb20wDQYJKoZIhvcNAQELBQAD
ggEBAFMH+KMuoyc4z8TXpir+qptIrnqNb1klioxg8zpyvslXw5vmOjP+u6WXN3rK
9f1YqONz77+h0QO2vx/gBYmx1Ax0e/xfIw0b1T+HOXCjk5Z9EL4zxx4oiotZltza
meWmuIDNuIkEbmQJZ55ET3UFtjQOkJCPXFTye9imB/jAQplLpFEL7JXP4jbqD64Y
Cr+R+xfzKk1vlOLj4a36atZeLrvqz176jUC/KFHjvUaa+vW5FByoWtOb2FKbdBC7
uebgS7SNRiqw2w7FbvQW9VsviOA7s7ZPsI6yB2O926zm7lrxXMQUXpaL+O6bXx0m
uU0bCHvkCBRzA+ocsBEH7sxAgI8=
-----END CERTIFICATE-----
`;

const KEY_1A = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDD3haNpvqqfOQM
OhmCfMpRKizMe+Q7ihNGKj50sdZo3pPWcJ5hqhaXOMFXNKenIeUqYKPPJiUsVtZ0
3G7J6qvyOzT+l9BIIMAl629YkLAepwPFhX187GM1xtHIrbYdxBb+JqoMUGZNv0c+
nbPIfuya4UOBLrMQVaKe2hG2SLOoCF2SXdyEj2yhQrmNWg4r1/3FFsYwZ/wkG4F6
+bN1naSiynfjoW5XdcLHOy9VzHe5v5A3QaArYwZb5zmDAaaW06bJx0ykBMjCu/tG
1UfnVwSMsdUafJKUyeYhMN20yd3Z2UyNKF6EFxH9afj2IbPnLqYzPWzk03tOO3Oa
ZglzHewJAgMBAAECggEACmEtjsonhHtj1mYJzglw60Yx45A5MxKJHPHGJ4b5Fsuc
yANl0UUjN1ZRoJ5wuAGq1EkUxTh/Rc9ARCceU+L0w7xxfYBsEDZ0GE5WsznPq4As
Sf5d/Q3F4CauHVVfTkqC8Wr5Hffww/P8AYx354saXMbNPf5MjPQMzyA9SgymQKRB
Ca88cZRTSKAO1exTCLas8Lc5d22uJADKhCivjZzRt2eKf3bX2Kr0N89M76QDVWIV
jcCDHxZ2yd2nkS8N9S8kHJQatmc5/YRhcCqfuJSrRNq/vUXKAL7od/PHiB/s+fe8
mboPovuElV6Qhwea8wuLDKpmZpPz9vxyNkDeVyhVhQKBgQDyvumG5lrn9iuDTFaf
MrvQGLzoIhu6CnRJQhMjOM8zfa+h74Ej9bZFwzIAv1abs0rkdn7/Lw7Y4+14y4V0
V8JZ09RMStLCCMa4se30P7+H6P4sVRvgIo7ACSNyJ5AyotgCXGUQw+rU4Ew0B92o
oKuyPzzjiSV1MB2t0LehnHzPywKBgQDOj+odrz/hQOvDC1bzpqX4f5iVG2hfwWzz
AsgRbojCp0KlrBW6Fz2LHLDk9EyCXON2xDhIHnzgHvkhleaNMFFoZu7aIOJjjE2k
uZt8ZusDWHDoFmvhgijHYo50CRm+iP5MqZnZ330h2UpyLsDpsFMuUTbIh86QeoUs
287xPBSQ+wKBgQCYM+Qw1VbCgrOdy8u0Xhcsz5YC5wADknJ/TJK7Tu98FZ5+JrIO
Xg4/h7heh5pCXhTjUvkl/9eLXr6TMukmnbAaqps+itvDFcWkIMxWjXIGQay9F1A3
JPPkrNYwyWW8miZetJgZ/v3LJCgjp5rwFG4TgVsoP+HgrJ6vUWMSThBkKQKBgCUP
/3LKEg0pp+O8MiLPoPIAevEuFMExpInJ0voFujYq6rNtOAzGxL0kLb029E9juVCD
DpIqHj/cbtkO22oz5Dd2WJ78zYINF5VZ1EMy+DIGeWO7OiohP43e6i55v4vHatF4
kOldx0b+hPQN3YFQqOwjmE/Mxkx4H1MYMX5pSEtnAoGAVh/vrfIAm6BlnHN8bOEy
guJG67NWTGleZd/z3dsyjqZr/TKsUR/qnsvN+uIJF6xB8CAGrwGuPcPk2p+91CKP
zGSvSBL56mSeLh7EWOVPkGBWxavEcZagZ6ehppK/8BjVPnzR4B2d+vh+WBY9uJMH
XBcpU0H7jtbDMicqxDGkEo4=
-----END PRIVATE KEY-----
`;

const CERT_1B = `-----BEGIN CERTIFICATE-----
MIIDQDCCAiigAwIBAgIJAKGWJJtQyhFkMA0GCSqGSIb3DQEBCwUAMEgxJzAlBgNV
BAMMHmFsY2hlbXktZmx5LWNlcnQtMS5leGFtcGxlLmNvbTEQMA4GA1UECgwHQWxj
aGVteTELMAkGA1UEBhMCVVMwHhcNMjYwODE5MDczMzA4WhcNMzYwODE2MDczMzA4
WjBIMScwJQYDVQQDDB5hbGNoZW15LWZseS1jZXJ0LTEuZXhhbXBsZS5jb20xEDAO
BgNVBAoMB0FsY2hlbXkxCzAJBgNVBAYTAlVTMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEA1H+Zm+wZgrZXb6yMUBCtLXUFxAiQwtrW3CS+pFiRKqUAF/NW
bUzu1ksugXhsFFiLh0fCjsk5DEUh9Slix18pI/OvJM6Ae5SONl5QAwzirAwTzQLq
TFI2d2HTktF/RSuvM5gSI2xS0Fcpgh277AIuT4+UYQY7lt2sxpMt8z/77ir0kJEC
+Kdn7h+YeFJwS7fQM4vy6onilQR1hwQIITh8oAvabygorRfKirw23DFZv6/OM5Dq
L8oR9G1N1C07cBCEbyWvJXcSB1hPnpIMSW3DrB4zvUNukuxcyYPbN2jTbYCm2vzU
UP+yYCSxE/MetpkJsBcf9pQa29/PF9Sx1+R2HQIDAQABoy0wKzApBgNVHREEIjAg
gh5hbGNoZW15LWZseS1jZXJ0LTEuZXhhbXBsZS5jb20wDQYJKoZIhvcNAQELBQAD
ggEBAJvY/S7A1fI+zuvzIgmYOnku9f9VEu/fVXyNI6ZJHj1g7sF69H30R3VwRJGe
0OaVRxrjcBf/WikVXMrevkb14xmWVGPyJY86lUE5ofF/H/FL/zHQ2KBGJqZdffug
LZydgkFHL7RX1Bo7kbQbIG0SithWnV2Gibx0QnW/HHh2OjOuYP9jSGFL4zYiVjRq
qIPeyOUwvVUDZcYYKTIVt2EMj5jHZFH6yHnVbJnKYjlJIs7ywzK9/X24uGI49NpX
knNTol8YVudJSO/V0DGsADj7kINIxs5GgwtQ0AUJvb+6P0iDVFxWVjTsF2JOf0zW
TmEwSgr3XQioUtj36eJ8Puux8w4=
-----END CERTIFICATE-----
`;

const KEY_1B = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDUf5mb7BmCtldv
rIxQEK0tdQXECJDC2tbcJL6kWJEqpQAX81ZtTO7WSy6BeGwUWIuHR8KOyTkMRSH1
KWLHXykj868kzoB7lI42XlADDOKsDBPNAupMUjZ3YdOS0X9FK68zmBIjbFLQVymC
HbvsAi5Pj5RhBjuW3azGky3zP/vuKvSQkQL4p2fuH5h4UnBLt9Azi/LqieKVBHWH
BAghOHygC9pvKCitF8qKvDbcMVm/r84zkOovyhH0bU3ULTtwEIRvJa8ldxIHWE+e
kgxJbcOsHjO9Q26S7FzJg9s3aNNtgKba/NRQ/7JgJLET8x62mQmwFx/2lBrb388X
1LHX5HYdAgMBAAECggEBAK0ApaLX+Xz9zvnQVPvqV9OmbmdHQfQiDsNz9vH+WVGK
vCTDrB2YgOpekyI9VGDMJeyhc7ikApoGvrrGUvFWfDwU7QbeSKRUMeP5rNKO7wx7
WLOUKASy+jz/nCzv+tnp0t4CdOH6EwIjtFuGsbRXojSMBJVpaaJOH5gbw1FDSmx/
eI1TRkwU7kHKOUkEoOHIrl1JFF5MiwtDIxYkQd6LmS1hL1oLBl4hNuUzlWVz6Utz
2dP3iMNXHQ+brEw5C+v6YUk+t5goV3SIW/EKREpAIyw6zhXtGYTsPLzd6S0VrA7j
NI6kS6YNVRWoZHxmZEJBhgvzGN2N4UtgIAg2DCHBjoECgYEA6eAfGT5zBG5IVemr
x08u45dlf32ZNmKazr+LY/6+81x6ep5jc+DOUpe3muBg0gfxSCCZoMZpbIdr6STW
Tl/b8JCfgJ5ZeJRAiFYNfpKkfxfCjJ0df02dsXxh4bHJ5kfPfoC5ndgpMeg0oR+c
0TvtdIspoTrdqNBib5qtnc+BCTkCgYEA6JnHvaCp/C03uP5lXD7zSOTj0/uRzQj8
eh0W1ucgZDMlwxk+nGFj8sjhSKq5BrGskr3X9lD8O4gGJ0CYnnfA5v2sKIubWKJw
p1J3vwjZNaCXyfl2GgU8i0i0tKqb6GKNikyEYJY8LzImLEwHsJBFjqtmQ/INAZgG
WRisYhZBiAUCgYAmWg1fe2ErGdac2AvGTFLZGYuYY4VLaNIQE1MNW8n+aGzhTLXs
W7IZ0y1VpXPbHVhQxp/KwJ6rIG3uto66HXgYs+6kDdOINW97q/jch7mX6dKKcn1S
0eyJHWeDtj7wl1gMW5mUq8zdlUGEJoX1vckLsoJqIRgWRc3OlWPhHBUB6QKBgQC3
aNMsfqyrEYi30blhNK4nk3zmoZ8FOwnCzH8+878B46bqIVTSgKUMQ0QJRb1iPuWi
TBonuxI5avfXKcNuaWVtfyeqTPMwv93uwkN0GmkUNU6bT57Fw81K0wjS0Rjg9B1B
qTZU5wIMARJCqa0Cl7CRYCviddG1qQeQZ7k+GuiPdQKBgHlmMzKipMwFinvDyhNw
6G8UKF+GRx1I4CnuEm6F8l+gguNQ4ufjeCpqepJQ0vQJ92UJtRdK2y5K3Wg7wl6l
5/txHtxiDrOQtXHD6fZGOP9FeyUCzM15t+dskhLsnxBLbnSAbJ1+UG1rMXCGFt87
FgKFMKpXLAf0maBRv4RowQtS
-----END PRIVATE KEY-----
`;

const CERT_2 = `-----BEGIN CERTIFICATE-----
MIIDQDCCAiigAwIBAgIJAKXks8DaxmKRMA0GCSqGSIb3DQEBCwUAMEgxJzAlBgNV
BAMMHmFsY2hlbXktZmx5LWNlcnQtMi5leGFtcGxlLmNvbTEQMA4GA1UECgwHQWxj
aGVteTELMAkGA1UEBhMCVVMwHhcNMjYwODE5MDczMzA5WhcNMzYwODE2MDczMzA5
WjBIMScwJQYDVQQDDB5hbGNoZW15LWZseS1jZXJ0LTIuZXhhbXBsZS5jb20xEDAO
BgNVBAoMB0FsY2hlbXkxCzAJBgNVBAYTAlVTMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEA7QHJUNwTdk3V5JlofytnMAubCB+iAclI6FLkCPS8tWekXPKD
jx8Xp3pnl8dkMhGxEpNpZSAdH7GoWZFhcOLLnT3ZojkeN8xCnVfXqvjZplLPN/ie
973shD2/cREVxRR/Bh6yc9NL528wSDEyNJ/lP5hdzNGSWiliE8jFaH3ymfeqhqYd
V3ghVBtyzP6l+2bjksiP2Km7ks+u0Qe9Mme4/u3wnY9dcWSCtpj8DcfKF+fUtMQh
RzD5TxWAV1ZZC8/bXqRzYWLbfHHVVDUE1wQI7fdEU4pwPiq70a9LyGKMlo1Upo+M
4EwR2QKtAFjNz8wvMsCODoM+Buv8QtDlPKV4WQIDAQABoy0wKzApBgNVHREEIjAg
gh5hbGNoZW15LWZseS1jZXJ0LTIuZXhhbXBsZS5jb20wDQYJKoZIhvcNAQELBQAD
ggEBAKIa9MMRCDU+W+HX+S04NWax2ixA0tO4tfQeeRJwbSxxCLaeUWK/J7Sb1avw
iLHSxBcpMeSvN42rL0aoQtZzLuxKg+COg+frLM+1lCRf5lRZilknpFV8BUb5wWmb
mGbNlU5z9hmkZ2cX/50IYLaQSEXrCVofq9KBev/ohA6VtT4WEd+to1aIP0h45MmT
qT0+MGBT2OZVIC15tvm4K2Aw0psIkG1R+WxZDLnIIyGCN/3eHL6kAm3njXxGj+81
K3xJ/mfJ6UgPvnuAbqeC+rHmWtFRbJpSI85HuFkvi60O+P1u77EjuSFmWFsLJrnp
/qOFL9VsXMBN3vNu7u/0ZBUBUVI=
-----END CERTIFICATE-----
`;

const KEY_2 = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDtAclQ3BN2TdXk
mWh/K2cwC5sIH6IByUjoUuQI9Ly1Z6Rc8oOPHxenemeXx2QyEbESk2llIB0fsahZ
kWFw4sudPdmiOR43zEKdV9eq+NmmUs83+J73veyEPb9xERXFFH8GHrJz00vnbzBI
MTI0n+U/mF3M0ZJaKWITyMVoffKZ96qGph1XeCFUG3LM/qX7ZuOSyI/YqbuSz67R
B70yZ7j+7fCdj11xZIK2mPwNx8oX59S0xCFHMPlPFYBXVlkLz9tepHNhYtt8cdVU
NQTXBAjt90RTinA+KrvRr0vIYoyWjVSmj4zgTBHZAq0AWM3PzC8ywI4Ogz4G6/xC
0OU8pXhZAgMBAAECggEBAI++eZ71G0ixRHz1Hg+i/16Aa3Kt3NBAiFt/ipZz+M/9
IA7Pd0MilHIbJyFC6V4EpOSjS1Tt+TvzwCsypWqV4vBnRsvA4Lbux6guUrt7WmYp
60wDGkcfhYde+/FTb2SsXa4UiB7/lBW1tg7S56RLJftAKgPDR4QvfTCKoFATs0P1
az0u0cDhDQXSLoCIs+FXswMa/o1uvPyv2SR1yj3z6G5qth55u5mOXylDu1Se7r3y
oM5WWV1zoSBbHNsHRu3UbOkm0stPyj2/01KU3LTuGDwlT9hfv+x4zsnTgo+CGOck
vLNvAywiD8td7XxOEwEVaksSAJQ80ge+9Uv7nDWlCdECgYEA+rldCBZ+2E/BKRsV
R9UkIi1iqwJxSR03hrU3SGbAW9S85JnIkqOcgJRtlhzMtlQ4Cym4tC/hEwcJtoZS
YQyFCrrxwLwwGuKIReqVwoQgqpJrhKs3+eCT/ssHTnnufQ68ObZUTDe3/yd5W0MR
45sw5ucdXasNsrJ5VIwgEZ0J6bcCgYEA8f6HnW9uT6UqhcFSlA6JUOzyQxKSwRBX
15l2wqAGOytbPfxo0t88RNw0zDCMLLJW/h4nH14TIqsZvmPVgbci3aOl8iK4p6Cs
rU6fPObzqyqWahB0uWxlvkV5xPh69lpPXgW4FHS2AJ/7LuT0K7l1xskFS0uygk82
NcYXOwZ37m8CgYEAjzAVhWzzfC3wLr2c5a1AOZSZ6Pg4In1hHLmZnOuxp8BTMGrz
NWvjETuzaiuAbhCjAR0Oszk03V0Dmw4TNgGkaYBiWKQhBPmiwes7JB+5WDDO3rG6
AibT3ous3JCeNyWXMY6DjhO0LTAqCoi/SrFyuCv9hWUPKaLrz/FGz0hURPkCgYB/
wZeJFzYOmCz91lUpUw9NiPpRTLHreRxW928KSv9fJ4GRFPumMDKaTAMXtZ2bTz+8
AuE2nyzNBbWenQgv5iZjCq1mSsxfuuTOzg4lUexcdixYrH1jEwYX0If75A7OllkG
U1CehAs+AzfRxw/dMZkrLB8+ZCVGxFjjRMQo5j5UwwKBgAL8u/8C5ZDlK9/h85NJ
jQGt3JmtR2FDjlamV6wAese7LgmVt7PPz/Ou42cOFDBN/p9fheLhNOA0Vo4RX6Y0
ikCU8TnSPOzNvJPwSZQnP0A4fbMGUlXa5q/cmbK1VeiD2f5FdJ+G4oIlRYuCxCgd
onolH/5YrvTrrhSOZeUzS72j
-----END PRIVATE KEY-----
`;

const waitUntilAppGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilCertGone = (appName: string, hostname: string) =>
  machines.getAppCertificate({ app_name: appName, hostname }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const deleteIfPresent = (appName: string, hostname: string) =>
  machines
    .deleteAppCertificate({ app_name: appName, hostname })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

test.provider(
  "create, update, and delete a custom certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("CertApp");
          const cert = yield* Fly.Certificate("Www", {
            app,
            hostname: CUSTOM_HOSTNAME,
            kind: "custom",
            fullchain: CERT_1A,
            privateKey: KEY_1A,
          });
          return { app, cert };
        }),
      );

      expect(created.cert.appName).toEqual(created.app.appName);
      expect(created.cert.hostname).toEqual(CUSTOM_HOSTNAME);
      expect(created.cert.source).toEqual("custom");
      expect(created.cert.status).toEqual(expect.any(String));

      const fetched = yield* machines.getAppCertificate({
        app_name: created.app.appName,
        hostname: CUSTOM_HOSTNAME,
      });
      expect(fetched.hostname).toEqual(CUSTOM_HOSTNAME);
      expect(
        fetched.certificates?.some((entry) => entry.source === "custom"),
      ).toBe(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("CertApp");
          const cert = yield* Fly.Certificate("Www", {
            app,
            hostname: CUSTOM_HOSTNAME,
            kind: "custom",
            fullchain: CERT_1B,
            privateKey: KEY_1B,
          });
          return { app, cert };
        }),
      );

      expect(updated.cert.hostname).toEqual(CUSTOM_HOSTNAME);
      expect(updated.cert.source).toEqual("custom");
      expect(updated.cert.appName).toEqual(created.app.appName);
      expect(updated.app.appId).toEqual(created.app.appId);

      const refetched = yield* machines.getAppCertificate({
        app_name: updated.app.appName,
        hostname: CUSTOM_HOSTNAME,
      });
      expect(refetched.hostname).toEqual(CUSTOM_HOSTNAME);
      expect(
        refetched.certificates?.some((entry) => entry.source === "custom"),
      ).toBe(true);

      yield* stack.destroy();

      const certGone = yield* waitUntilCertGone(
        created.app.appName,
        CUSTOM_HOSTNAME,
      );
      expect(certGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when hostname changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("CertReplaceApp");
          const cert = yield* Fly.Certificate("Www", {
            app,
            hostname: CUSTOM_HOSTNAME,
            kind: "custom",
            fullchain: CERT_1A,
            privateKey: KEY_1A,
          });
          return { app, cert };
        }),
      );

      expect(created.cert.hostname).toEqual(CUSTOM_HOSTNAME);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("CertReplaceApp");
          const cert = yield* Fly.Certificate("Www", {
            app,
            hostname: REPLACE_HOSTNAME,
            kind: "custom",
            fullchain: CERT_2,
            privateKey: KEY_2,
          });
          return { app, cert };
        }),
      );

      expect(replaced.cert.hostname).toEqual(REPLACE_HOSTNAME);
      expect(replaced.cert.hostname).not.toEqual(created.cert.hostname);
      expect(replaced.cert.source).toEqual("custom");
      expect(replaced.cert.appName).toEqual(created.app.appName);

      const fetched = yield* machines.getAppCertificate({
        app_name: replaced.app.appName,
        hostname: REPLACE_HOSTNAME,
      });
      expect(fetched.hostname).toEqual(REPLACE_HOSTNAME);

      const oldGone = yield* waitUntilCertGone(
        created.app.appName,
        CUSTOM_HOSTNAME,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const certGone = yield* waitUntilCertGone(
        replaced.app.appName,
        REPLACE_HOSTNAME,
      );
      expect(certGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(replaced.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("CertListApp");
          const cert = yield* Fly.Certificate("Www", {
            app,
            hostname: CUSTOM_HOSTNAME,
            kind: "custom",
            fullchain: CERT_1A,
            privateKey: KEY_1A,
          });
          return { app, cert };
        }),
      );

      const provider = yield* Provider.findProvider(Fly.Certificate);
      const all = yield* provider.list();
      const found = all.find(
        (row) =>
          row.appName === deployed.app.appName &&
          row.hostname === CUSTOM_HOSTNAME,
      );
      expect(found).toBeDefined();
      expect(found?.source).toEqual("custom");

      yield* stack.destroy();

      const certGone = yield* waitUntilCertGone(
        deployed.app.appName,
        CUSTOM_HOSTNAME,
      );
      expect(certGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(deployed.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "ACME create is rejected without a hostname",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("AcmeProbeApp");
        }),
      );

      const result = yield* Effect.result(
        machines.createAppAcmeCertificate({
          app_name: app.appName,
        }),
      );

      if (Result.isFailure(result)) {
        expect(["BadRequest", "UnprocessableEntity"]).toContain(
          result.failure._tag,
        );
      } else {
        const hostname = result.success.hostname;
        if (hostname !== undefined && hostname.length > 0) {
          yield* deleteIfPresent(app.appName, hostname);
        }
        expect(result.success.hostname).toBeUndefined();
      }

      yield* stack.destroy();

      const gone = yield* waitUntilAppGone(app.appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
