import { useEffect, useState } from "react";
import { yantraSvg } from "../../brand/yantra";
import "./PreviewComment.css";

/*
 * The pull request page for the `GitHub.Comment` in the preview stack.
 * Each push redeploys the preview and the same comment is edited in place
 * (its body embeds the commit), then merging destroys the preview and, with
 * `allowDelete: true`, deletes the comment.
 *
 * Every frame derives from ms elapsed in the loop.
 */

const URL = "https://pr-147.my-app.workers.dev";
const PUSHES = [
  { sha: "a8f3d21", msg: "Add image upload to /photos" },
  { sha: "c19e4b0", msg: "Set the content type on upload" },
  { sha: "7d02f5a", msg: "Reject empty uploads" },
];
// Per push: the push lands, CI deploys, then the comment is written.
const PUSH_MS = 3400;
const DEPLOY_AT = 500;
const DEPLOYED_AT = 1900;
const MERGE_AT = PUSHES.length * PUSH_MS + 400;
const DELETED_AT = MERGE_AT + 1500;
const LOOP_MS = DELETED_AT + 2600;
const BOT_LOGO = yantraSvg({ size: 16, theme: "dark" });

const isPaused = () =>
  document.documentElement.classList.contains("alc-motion-paused") ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function PreviewComment() {
  // A still frame (the third revision) until the loop starts.
  const [t, setT] = useState(PUSHES.length * PUSH_MS - 200);

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
    }, 80);
    return () => {
      clearInterval(id);
      removeEventListener("alc-motion-change", onMotion);
    };
  }, []);

  const pushes = PUSHES.map((p, i) => {
    const at = i * PUSH_MS;
    return {
      ...p,
      shown: t >= at,
      deploying: t >= at + DEPLOY_AT && t < at + DEPLOYED_AT,
      deployed: t >= at + DEPLOYED_AT,
    };
  }).filter((p) => p.shown);

  // The comment reflects the latest finished deploy.
  const revision = pushes.filter((p) => p.deployed).length;
  const current = revision ? PUSHES[revision - 1]! : undefined;
  const justEdited =
    revision > 1 &&
    t >= (revision - 1) * PUSH_MS + DEPLOYED_AT &&
    t < (revision - 1) * PUSH_MS + DEPLOYED_AT + 900;
  const merged = t >= MERGE_AT;
  const deleting = t >= MERGE_AT + 600 && t < DELETED_AT;
  const deleted = t >= DELETED_AT;

  const status = (p: (typeof pushes)[number]) =>
    p.deploying ? (
      <span className="pc-status pc-status--run">
        <span className="pc-spin" /> deploying
        <span className="pc-wide"> pr-147</span>
      </span>
    ) : p.deployed ? (
      <span className="pc-status pc-status--ok">
        ✓<span className="pc-wide"> preview</span> deployed
      </span>
    ) : (
      <span className="pc-status">queued</span>
    );

  return (
    <div className="pc" aria-hidden>
      <div className="pc-bar">
        <span className="pc-dot" style={{ background: "var(--alc-dot-red)" }} />
        <span className="pc-dot" style={{ background: "var(--alc-dot-yellow)" }} />
        <span className="pc-dot" style={{ background: "var(--alc-dot-green)" }} />
        <span className="pc-bar__url">github.com/acme/my-app/pull/147</span>
      </div>
      <div className="pc-body">
        <div className="pc-title">
          Add image upload to /photos <span className="pc-muted">#147</span>
        </div>
        <div className="pc-state">
          <span className={`pc-pill ${merged ? "pc-pill--merged" : ""}`}>
            {merged ? "Merged" : "Open"}
          </span>
          <code>feature/photo-upload</code>
          <span className="pc-muted">→</span>
          <code>main</code>
        </div>

        <ol className="pc-timeline">
          {pushes.slice(0, 1).map((p) => (
            <li key={p.sha} className="pc-push pc-enter">
              <span className="pc-push__who">you</span>
              <span>
                pushed <code>{p.sha}</code> <span className="pc-muted pc-wide">{p.msg}</span>
              </span>
              {status(p)}
            </li>
          ))}

          {current && !deleted && (
            <li
              className={`pc-comment pc-enter ${justEdited ? "is-edited" : ""} ${deleting ? "is-deleting" : ""}`}
            >
              <div className="pc-comment__head">
                <span className="pc-avatar" dangerouslySetInnerHTML={{ __html: BOT_LOGO }} />
                <strong>alchemy</strong>
                <span className="pc-bot">bot</span>
                <span className="pc-muted pc-wide">commented</span>
                {revision > 1 && (
                  <span className="pc-edited">
                    edited · <span className="pc-wide">revision</span>
                    <span className="pc-narrow">rev</span> {revision}
                  </span>
                )}
              </div>
              <div className="pc-comment__body">
                <span className="pc-label">Preview: </span>
                <span className="pc-link">
                  <span className="pc-wide">https://</span>
                  {URL.replace("https://", "")}
                </span>{" "}
                <span className="pc-nowrap">
                  (
                  <span key={current.sha} className="pc-sha">
                    {current.sha}
                  </span>
                  )
                </span>
              </div>
              {deleting && (
                <div className="pc-comment__gone">pr-147 destroyed · deleting this comment</div>
              )}
            </li>
          )}
          {deleted && (
            <li className="pc-event pc-enter pc-muted">comment deleted with the pr-147 preview</li>
          )}

          {pushes.slice(1).map((p) => (
            <li key={p.sha} className="pc-push pc-enter">
              <span className="pc-push__who">you</span>
              <span>
                pushed <code>{p.sha}</code> <span className="pc-muted pc-wide">{p.msg}</span>
              </span>
              {status(p)}
            </li>
          ))}

          {merged && (
            <li className="pc-push pc-enter">
              <span className="pc-push__who pc-push__who--merged">↳</span>
              <span>
                merged into <code>main</code>
              </span>
              <span className="pc-status pc-status--ok">✓ prod deployed</span>
            </li>
          )}
        </ol>
      </div>
    </div>
  );
}
