import { useEffect, useState, type CSSProperties } from "react";
import { highlightTS } from "../marketing/highlightTS";
import "./TypePolicy.css";

/*
 * Each AWS binding is one IAM action, and it hands back a client typed for
 * that one operation. The loop swaps `AWS.S3.PutObject` for
 * `AWS.S3.GetObject`: the generated policy changes to `s3:GetObject`, and the
 * upload stops compiling because a GetObject request has no `Body`.
 *
 * The diagnostic is TypeScript's real message for this code.
 */

const PUT = "PutObject";
const GET = "GetObject";
const ERROR =
  "Object literal may only specify known properties, and 'Body' does not exist in type 'Omit<GetObjectRequest, \"Bucket\">'.";

// Swap, check, hold the error, swap back, check, hold.
const T_NARROW = 1000;
const T_ERROR = T_NARROW + 600;
const T_WIDEN = T_ERROR + 1900;
const T_CLEAN = T_WIDEN + 600;
const LOOP_MS = T_CLEAN + 1000;
const ROLL_MS = 450;

const isPaused = () =>
  document.documentElement.classList.contains("alc-motion-paused") ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const hl = (s: string) => ({ __html: highlightTS(s) });

/** A value that rolls up when it changes (the hero's roll, from the deck). */
function Slot({ was, now, k }: { was: string; now: string; k: number }) {
  return (
    <span
      key={k}
      className={`tp-slot ${was !== now ? "is-rolling" : ""}`}
      style={
        {
          "--from": `${was.length}ch`,
          "--to": `${now.length}ch`,
          width: `${now.length}ch`,
        } as CSSProperties
      }
    >
      <span className="tp-slot__strip">
        <span dangerouslySetInnerHTML={hl(was)} />
        <span dangerouslySetInnerHTML={hl(now)} />
      </span>
    </span>
  );
}

export default function TypePolicy() {
  // A still frame (the error) until the loop starts.
  const [t, setT] = useState(T_ERROR + 200);

  useEffect(() => {
    let paused = isPaused();
    let last = performance.now();
    let elapsed = 0;
    const onMotion = () => {
      paused = isPaused();
    };
    addEventListener("alc-motion-change", onMotion);
    const id = setInterval(() => {
      const now = performance.now();
      if (!paused) {
        elapsed = (elapsed + now - last) % LOOP_MS;
        setT(elapsed);
      }
      last = now;
    }, 60);
    return () => {
      clearInterval(id);
      removeEventListener("alc-motion-change", onMotion);
    };
  }, []);

  const swapped = t >= T_NARROW && t < T_WIDEN;
  const rolling =
    (t >= T_NARROW && t < T_NARROW + ROLL_MS) || (t >= T_WIDEN && t < T_WIDEN + ROLL_MS);
  const now = swapped ? GET : PUT;
  const was = rolling ? (swapped ? PUT : GET) : now;
  const rollKey = swapped ? 1 : 0;
  const checking =
    (t >= T_NARROW + ROLL_MS && t < T_ERROR) || (t >= T_WIDEN + ROLL_MS && t < T_CLEAN);
  const error = t >= T_ERROR && t < T_WIDEN + ROLL_MS;

  return (
    <div className="tp" aria-hidden>
      <div className="tp-editor">
        <div className="tp-bar">
          <span className="tp-dot" style={{ background: "var(--alc-dot-red)" }} />
          <span className="tp-dot" style={{ background: "var(--alc-dot-yellow)" }} />
          <span className="tp-dot" style={{ background: "var(--alc-dot-green)" }} />
          <span className="tp-bar__file">src/Photos.ts</span>
          <span className={`tp-check ${error ? "is-error" : checking ? "is-checking" : "is-ok"}`}>
            {error ? "✗ 1 error" : checking ? "type-checking…" : "✓ no errors"}
          </span>
        </div>
        <pre className="tp-code">
          <span
            dangerouslySetInnerHTML={hl(
              'export const PhotosS3 = Layer.effect(\n  Photos,\n  Effect.gen(function* () {\n    const bucket = yield* AWS.S3.Bucket("Photos");\n',
            )}
          />
          <span className={`tp-line ${rolling || swapped ? "is-lit" : ""}`}>
            <span dangerouslySetInnerHTML={hl("    const write = yield* AWS.S3.")} />
            <Slot was={was} now={now} k={rollKey} />
            <span dangerouslySetInnerHTML={hl("(bucket);")} />
          </span>
          {"\n"}
          <span dangerouslySetInnerHTML={hl("    return {\n      upload: (name, body) =>\n")} />
          <span className={`tp-line ${error ? "is-error" : ""}`}>
            <span dangerouslySetInnerHTML={hl("        write({ Key: name, ")} />
            <span className={error ? "tp-squiggle" : ""} dangerouslySetInnerHTML={hl("Body")} />
            <span dangerouslySetInnerHTML={hl(": body }),")} />
          </span>
          {"\n"}
          <span className={`tp-diag ${error ? "is-shown" : ""}`}>
            <span className="tp-diag__x">✗</span> {ERROR}
          </span>
          <span dangerouslySetInnerHTML={hl("    };\n  }),\n);")} />
        </pre>
      </div>

      <div className="tp-type">
        <div className="tp-type__head">
          <span>iam-policy.yaml</span>
          <span className="tp-muted">generated at deploy</span>
        </div>
        <pre className="tp-yaml">
          <span className="tp-y-c"># the Api function's role</span>
          {"\n"}
          <span className="tp-y-k">Statement</span>:{"\n"}
          {"  - "}
          <span className="tp-y-k">Effect</span>: <span className="tp-y-v">Allow</span>
          {"\n    "}
          <span className="tp-y-k">Action</span>:{"\n"}
          <span className={`tp-line ${rolling || swapped ? "is-lit" : ""}`}>
            {"      - "}
            <span className="tp-y-v">s3:</span>
            <Slot was={was} now={now} k={rollKey} />
          </span>
          {"\n    "}
          <span className="tp-y-k">Resource</span>:{"\n      - "}
          <span className="tp-y-v">arn:aws:s3:::my-app-photos-x7k2/*</span>
        </pre>
      </div>
    </div>
  );
}
