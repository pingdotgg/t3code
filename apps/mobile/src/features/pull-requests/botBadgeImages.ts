/** Only asset paths are bot badges; keep same-host screenshots and all inline markdown images. */
const BOT_BADGE_PREFIXES = [
  "static.devin.ai/assets/",
  "cursor.com/assets/images/",
  "storage.googleapis.com/coderabbit_public_assets/",
  "greptile-static-assets.s3.amazonaws.com/badges/",
  "static.graphite.dev/",
  "qodo.ai/wp-content/uploads/",
  "cubic.dev/buttons/",
  "github.githubassets.com/static/images/icons/copilot-code-review/",
  "gstatic.com/codereviewagent/",
  "vercel.com/vercel-agent-view-suggestion-",
  "agents-vade-review.vercel.sh/",
  "new-codeant-butcket.s3.us-west-1.amazonaws.com/badges/",
  "pr-comments-assets.blacksmith.sh/",
  "app.roocode.com/cloud-agents/github/",
  "app.parameter.ai/_static/icons/",
  "img.shields.io/",
  "raster.shields.io/",
  "dependabot-badges.githubapp.com/",
  "developer.mend.io/api/mc/badges/",
  "api.securityscorecards.dev/projects/",
  "github-app-statics.socket.dev/",
  "static.deepsource.com/comment_artifacts/",
  "sonarsource.github.io/sonarcloud-github-static-resources/",
  "codescene.io/imgs/svg/",
  "app.codecov.io/gh/",
  "github.com/codecov/engineering-team/assets/",
  "codspeed.io/pr-report/",
  "static.trunk.io/assets/",
  "res.cloudinary.com/snyk/",
  "api.segment.io/v1/pixel/",
  "cla-assistant.io/pull/badge/",
  "vercel.com/static/status/",
  "vercel.com/api/www/avatar",
  "app.netlify.com/qr-code/",
  "workers.cloudflare.com/logo.svg",
  // Cloudflare Pages reuses one old GitHub upload as its logo.
  "user-images.githubusercontent.com/23264/106598434-9e719e00-654f-11eb-9e59-6167043cfa01.png",
  "qr.expo.dev/",
];

export function isBotBadgeImage(href: string) {
  const path = href.replace(/^https?:\/\/(?:www\.)?/i, "").toLowerCase();
  return BOT_BADGE_PREFIXES.some((prefix) => path.startsWith(prefix));
}
