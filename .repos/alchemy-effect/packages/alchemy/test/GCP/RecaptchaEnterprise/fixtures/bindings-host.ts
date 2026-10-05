import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { serveProbes } from "../../bindingHost.ts";

/** SCORE key the assessment is created against. */
export const Signup = GCP.RecaptchaEnterprise.Key("Signup", {
  displayName: "alchemy recaptcha assess",
  testingOptions: { testingScore: 0.8 },
  webSettings: { integrationType: "SCORE", allowAllDomains: true },
});

/**
 * Effect-native Cloud Run service exercising the reCAPTCHA Enterprise
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class RecaptchaBindingsHost extends GCP.Function<RecaptchaBindingsHost>()(
  "RecaptchaBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const createAssessment =
      yield* GCP.RecaptchaEnterprise.CreateAssessment(Signup);

    return {
      fetch: serveProbes({
        createAssessment: createAssessment({
          body: { event: { token: "03AGdBq27", expectedAction: "login" } },
        }).pipe(
          Effect.retry({
            // A just-created key takes a moment to propagate.
            while: (error) => error._tag === "InvalidSiteKey",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
        ),
      }),
    };
  }).pipe(Effect.provide(GCP.RecaptchaEnterprise.CreateAssessmentHttp)),
) {}
