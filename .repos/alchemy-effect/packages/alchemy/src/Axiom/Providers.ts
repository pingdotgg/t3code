import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { Annotation, AnnotationProvider } from "./Annotation.ts";
import { ApiToken, ApiTokenProvider } from "./ApiToken.ts";
import { AxiomAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Dashboard, DashboardProvider } from "./Dashboard.ts";
import { Dataset, DatasetProvider } from "./Dataset.ts";
import { Monitor, MonitorProvider } from "./Monitor.ts";
import { Notifier, NotifierProvider } from "./Notifier.ts";
import { View, ViewProvider } from "./View.ts";
import { VirtualField, VirtualFieldProvider } from "./VirtualField.ts";

export { Credentials } from "@distilled.cloud/axiom/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Axiom",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Axiom providers and credentials. Wires up Dataset, ApiToken, Notifier,
 * Monitor, Dashboard, VirtualField, View and Annotation resources, and
 * registers the Axiom AuthProvider so `alchemy login` can configure it.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Annotation,
      ApiToken,
      Dashboard,
      Dataset,
      Monitor,
      Notifier,
      View,
      VirtualField,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AnnotationProvider(),
        ApiTokenProvider(),
        DashboardProvider(),
        DatasetProvider(),
        MonitorProvider(),
        NotifierProvider(),
        ViewProvider(),
        VirtualFieldProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(AxiomAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
