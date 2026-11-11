import { useEffect, useRef, useState } from "react";
import { RollTemplate } from "./_roll";
import { sleep } from "./_terminal";

/*
 * The Photos module, cycling through its Layer on each provider: the same
 * service, a different resource and binding. Every variant fills the same
 * slots of one template, so the line count never changes and only the
 * slotted values roll.
 *
 * ⟨0⟩ the Layer, ⟨1⟩ the resource, ⟨2⟩ the binding, ⟨3⟩ the call that
 * stores the photo.
 */
const TEMPLATE = `export class Photos extends Context.Service<Photos, {
  upload(name: string, body: string): Effect.Effect<void>;
}>()("Photos") {}

export const ⟨0⟩ = Layer.effect(
  Photos,
  Effect.gen(function* () {
    const bucket = yield* ⟨1⟩("Photos");
    const photos = yield* ⟨2⟩(bucket);
    return {
      upload: (name, body) => ⟨3⟩,
    };
  }),
);`;

const PUT = "photos.put(name, body)";
const PUT_OBJECT = "photos({ Key: name, Body: body })";

// The labels and Layer names match the hero's (heroHosts.ts).
const VARIANTS: { label: string; values: string[] }[] = [
  {
    label: "Cloudflare",
    values: ["PhotosR2", "Cloudflare.R2.Bucket", "Cloudflare.R2.ReadWriteBucket", PUT],
  },
  { label: "AWS", values: ["PhotosS3", "AWS.S3.Bucket", "AWS.S3.PutObject", PUT_OBJECT] },
  {
    label: "GCP",
    values: ["PhotosGCS", "GCP.Storage.Bucket", "GCP.Storage.ReadWriteBucket", PUT],
  },
  { label: "Fly", values: ["PhotosTigris", "Fly.Bucket", "Fly.PutObject", PUT_OBJECT] },
  {
    label: "Railway",
    values: ["PhotosRailway", "Railway.Bucket", "Railway.PutObject", PUT_OBJECT],
  },
  { label: "Neon", values: ["PhotosNeon", "Neon.Bucket", "Neon.ReadWriteBucket", PUT] },
];

const SEGMENTS = TEMPLATE.split(/⟨(\d)⟩/);
// The widest line of any variant, so the card never resizes as values roll.
const WIDTH = Math.max(
  ...VARIANTS.flatMap(({ values }) =>
    TEMPLATE.replace(/⟨(\d)⟩/g, (_, i: string) => values[+i]!)
      .split("\n")
      .map((l) => l.length),
  ),
);
const DWELL_MS = 2600;

export default function PhotosLayers() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [roll, setRoll] = useState({ i: 0, was: VARIANTS[0]!.values, n: 0 });

  // Mark the card visible once it scrolls into view; cycling starts then.
  useEffect(() => {
    const obs = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        obs.disconnect();
        setVisible(true);
      },
      { threshold: 0.25 },
    );
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  const goTo = (i: number) =>
    setRoll((r) => (r.i === i ? r : { i, was: VARIANTS[r.i]!.values, n: r.n + 1 }));

  // Advance after each dwell. Every change (including a click on the reel)
  // restarts the dwell.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void sleep(DWELL_MS).then(() => {
      if (!cancelled) goTo((roll.i + 1) % VARIANTS.length);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, roll.n]);

  return (
    <div ref={ref} className="photos-layers">
      <ol className="hh-reel" aria-label="Providers">
        {VARIANTS.map((v, i) => (
          <li key={v.label}>
            <button
              type="button"
              className={`hh-reel__item ${i === roll.i ? "is-active" : ""}`}
              aria-pressed={i === roll.i}
              onClick={() => goTo(i)}
            >
              {v.label}
            </button>
          </li>
        ))}
      </ol>
      <div className="alc-code-block alc-code-block--compact">
        <div className="alc-code-block__header">
          <span className="alc-code-block__dot" style={{ background: "var(--alc-danger)" }} />
          <span className="alc-code-block__dot" style={{ background: "var(--alc-warn)" }} />
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-accent-bright)" }}
          />
          <span className="alc-code-block__filename">src/Photos.ts</span>
        </div>
        <pre className="alc-code-block__pre" tabIndex={0} aria-label="src/Photos.ts source">
          <span style={{ display: "inline-block", minWidth: `${WIDTH}ch` }}>
            <RollTemplate
              segments={SEGMENTS}
              was={roll.was}
              now={VARIANTS[roll.i]!.values}
              n={roll.n}
              lit
            />
          </span>
        </pre>
      </div>
    </div>
  );
}
