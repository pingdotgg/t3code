/**
 * The hero's provider reel: one API, the same request handler, on eight
 * providers. Adapted from the "Nine hosts, one API" roll in the talk deck
 * (demos/effect-prezzy/intro/snippets/anywhere/Api*.ts; there the module is
 * `Files`, here it's `Photos`, like the rest of the page).
 *
 * Props are plain objects: a prop accepts the resource's Effect directly
 * (`cluster: Cluster`), so nothing has to be yielded first.
 *
 * ⟨0⟩ is the host, ⟨1⟩ the props it needs beyond `main`, and ⟨2⟩ the
 * Photos Layer for that provider's storage.
 */
export const HOST_TEMPLATE = `export default ⟨0⟩(
  "Api",
  { main: import.meta.url⟨1⟩ },
  Effect.gen(function* () {
    const photos = yield* Photos;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        yield* photos.upload(request.url, yield* request.text);
        return HttpServerResponse.empty({ status: 201 });
      }),
    };
  }).pipe(Effect.provide(⟨2⟩)),
);`;

export interface HostResource {
  id: string;
  type: string;
  bindings?: string[];
}

export interface Host {
  /** Reel label: the provider. */
  label: string;
  values: [string, string, string];
  resources: HostResource[];
  url?: string;
}

export const HOSTS: Host[] = [
  {
    label: "Cloudflare",
    values: ["Cloudflare.Worker", "", "PhotosR2"],
    resources: [
      { id: "Photos", type: "Cloudflare.R2.Bucket" },
      { id: "Api", type: "Cloudflare.Worker", bindings: ["Photos"] },
    ],
    url: "https://api.my-app.workers.dev",
  },
  {
    label: "AWS",
    values: ["AWS.Lambda.Function", "", "PhotosS3"],
    resources: [
      { id: "Photos", type: "AWS.S3.Bucket" },
      { id: "Api", type: "AWS.Lambda.Function", bindings: ["Photos"] },
    ],
    url: "https://7xk2q.lambda-url.us-east-1.on.aws",
  },
  {
    label: "GCP",
    values: ["GCP.Run.Service", "", "PhotosGCS"],
    resources: [
      { id: "Photos", type: "GCP.Storage.Bucket" },
      { id: "Api", type: "GCP.Run.Service", bindings: ["Photos"] },
    ],
    url: "https://api-7xk2q-uc.a.run.app",
  },
  {
    label: "Kubernetes",
    values: ["Kubernetes.Deployment", ", cluster: Cluster, port: 3000", "PhotosGCS"],
    resources: [
      { id: "Photos", type: "GCP.Storage.Bucket" },
      { id: "Api", type: "Kubernetes.Deployment", bindings: ["Photos"] },
    ],
  },
  {
    label: "Fly",
    values: ["Fly.Service", "", "PhotosTigris"],
    resources: [
      { id: "Photos", type: "Fly.Bucket" },
      { id: "Api", type: "Fly.Service", bindings: ["Photos"] },
    ],
    url: "https://my-app-api.fly.dev",
  },
  {
    label: "Railway",
    values: ["Railway.Service", ", project: Project", "PhotosRailway"],
    resources: [
      { id: "Project", type: "Railway.Project" },
      { id: "Photos", type: "Railway.Bucket" },
      { id: "Api", type: "Railway.Service", bindings: ["Photos"] },
    ],
    url: "https://api-production.up.railway.app",
  },
  {
    label: "Hetzner",
    values: ["Hetzner.Service", ", server: Box, port: 3000", "PhotosVolume"],
    resources: [
      { id: "Box", type: "Hetzner.Server" },
      { id: "Photos", type: "Hetzner.Volume" },
      { id: "Api", type: "Hetzner.Service", bindings: ["Photos"] },
    ],
  },
  {
    label: "Neon",
    values: ["Neon.Function", ", branch: Main", "PhotosNeon"],
    resources: [
      { id: "Db", type: "Neon.Project" },
      { id: "Main", type: "Neon.Branch" },
      { id: "Photos", type: "Neon.Bucket" },
      { id: "Api", type: "Neon.Function", bindings: ["Photos"] },
    ],
  },
];

/** The template with one host's values filled in. */
export const hostSource = (values: readonly string[]) =>
  HOST_TEMPLATE.replace(/⟨(\d)⟩/g, (_, i: string) => values[+i]!);

/**
 * The same program for narrow screens: the props sit one per line and the
 * request handler is folded to `handler`, so no line passes ~42 columns.
 * Slot ⟨1⟩ holds the host's extra props on a line of their own.
 */
export const HOST_TEMPLATE_COMPACT = `export default ⟨0⟩(
  "Api",
  {
    main: import.meta.url,
    ⟨1⟩
  },
  Effect.gen(function* () {
    const photos = yield* Photos;
    return { fetch: handler };
  }).pipe(Effect.provide(⟨2⟩)),
);`;

/** A host's values for the compact template. */
export const compactValues = (values: readonly string[]) => [
  values[0]!,
  values[1] ? `${values[1].replace(/^, /, "")},` : "",
  values[2]!,
];
