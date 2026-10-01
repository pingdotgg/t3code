declare module "cloudflare:workers" {
  namespace Cloudflare {
    interface Env {
      TEST_POSTGRES_URL: string;
    }
  }
}
