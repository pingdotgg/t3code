const crypto = require("node:crypto");

async function notifyRelease({ github, repo, tag, sha, channel, url, secret, request = fetch }) {
  if (!url) return { status: "disabled" };
  let destination;
  try {
    destination = new URL(url);
  } catch {
    throw new Error("Release webhook requires a valid HTTPS endpoint");
  }
  if (
    destination.protocol !== "https:" ||
    destination.username ||
    destination.password ||
    !secret
  ) {
    throw new Error("Release webhook requires an HTTPS endpoint and a signing secret");
  }
  const { data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag });
  if (release.draft || !release.published_at || release.tag_name !== tag) {
    throw new Error("Release webhook requires a published release matching the requested tag");
  }
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Release webhook requires a full source commit SHA");
  const repository = `${repo.owner}/${repo.repo}`;
  const body = JSON.stringify({
    schema_version: 1,
    event: "release.published",
    repository,
    channel,
    tag: release.tag_name,
    commit_sha: sha,
    release_id: release.id,
    release_url: release.html_url,
    published_at: release.published_at,
  });
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  // Do not forward the endpoint token or signature to a redirected destination.
  // Reruns use the same delivery ID, so receivers can process them idempotently.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await request(destination, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "X-T3-Event": "release.published",
          "X-T3-Delivery": `${repository}:release:${release.id}`,
          "X-Hub-Signature-256": `sha256=${signature}`,
        },
        body,
      });
    } catch {
      if (attempt < 2) continue;
      // Transport errors can contain a credential-bearing URL. Keep it private.
      throw new Error("Release webhook transport failed after three attempts");
    }
    await response.body?.cancel();
    if (response.ok) return { status: "delivered", releaseId: release.id };
    if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
    throw new Error(`Release webhook returned HTTP ${response.status}`);
  }
}

module.exports = { notifyRelease };
