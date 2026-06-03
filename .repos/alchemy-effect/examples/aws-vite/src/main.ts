import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root element");
}

app.innerHTML = `
  <main class="page">
    <p class="eyebrow">alchemy + vite</p>
    <h1>Deploy a Vite SPA to AWS with CloudFront, ACM, and Route 53.</h1>
    <p class="lede">
      This example runs a Vite build and publishes the generated assets with
      <code>AWS.Website.StaticSite</code> behind a shared
      <code>AWS.Website.Router</code>.
    </p>
    <ul class="highlights">
      <li>Build artifacts uploaded to a private S3 bucket</li>
      <li>CloudFront Router in front of the site</li>
      <li>Optional custom domain with ACM validation and Route 53 alias records</li>
    </ul>
  </main>
`;
