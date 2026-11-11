args=("$@")
has_profile=false
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --) break ;;
    --profile)
      if [[ -z "${args[i+1]:-}" || "${args[i+1]}" == -* ]]; then
        echo "Error: --profile requires a profile name." >&2
        exit 1
      fi
      has_profile=true
      ((i++))
      ;;
    --profile=*)
      if [[ -z "${args[i]#--profile=}" ]]; then
        echo "Error: --profile requires a profile name." >&2
        exit 1
      fi
      has_profile=true
      ;;
  esac
done
if [[ "$has_profile" != true ]]; then
  echo "Error: pass --profile <name> explicitly to nuke resources." >&2
  exit 1
fi

# AWS.BackupSearch.SearchJob: AWS retains search-job records ~7 days; no delete API
# Cloudflare.Cache.RegionalTieredCache / Cloudflare.Logs.RetentionFlag /
# Cloudflare.AI.SecuritySettings: zone-singleton settings that always exist
# on entitled zones — delete restores the pre-management value (a no-op
# when enumerated), so the census would flag them forever.
# Cloudflare.AI.Gateway "default": auto-provisioned by Cloudflare when an AI Search
# instance is created; recreated on demand, so deleting it just churns.
# AWS.Logs.LogGroup /aws-glue/*: shared, service-managed groups Glue auto-creates
# for every crawler/job in the account. Glue Crawler/Job providers reap only
# their own streams in them; the empty groups themselves are spared.
# Cloudflare API tokens: user tokens are never touched (the team's hand-made
# superuser tokens live there). Account tokens are only deleted when their
# name matches the engine-generated physical-name pattern (ends in 16 base32
# chars) or is the old distilled SDK test leak; hand-named tokens (CI, team,
# Cloudflare-managed) are spared because tokens carry no ownership marker.
# Cloudflare.Email.Address alchemy-list-test@: standing test address — Cloudflare
# refuses to delete an address for ~15 min after creation (code 2032), so the
# EmailAddress test retains and re-adopts it instead of create/destroy churn.
pnpm -C ./stacks alchemy unsafe nuke --config ./src/nuke.ts  \
  --exclude 'AWS.BackupSearch.SearchJob' \
  --exclude 'Cloudflare.Zone*' \
  --exclude 'Cloudflare.Account*' \
  --exclude 'Cloudflare.DNS*' \
  --exclude 'Cloudflare.Ssl.UniversalSsl' \
  --exclude 'Cloudflare.Cache.RegionalTieredCache' \
  --exclude 'Cloudflare.Logs.RetentionFlag' \
  --exclude 'Cloudflare.AI.SecuritySettings' \
  --exclude 'Cloudflare.ApiToken.UserApiToken' \
  --exclude 'Cloudflare.Secret*' \
  --exclude 'Cloudflare.Organization.*' \
  --exclude 'AWS.IAM.User' \
  --exclude 'AWS.IAM.SAMLProvider' \
  --exclude 'AWS.IAM.OpenIDConnectProvider' \
  --exclude 'AWS.IAM.AccountAlias' \
  --exclude 'AWS.IAM.AccountPasswordPolicy' \
  --exclude 'AWS.IAM.LoginProfile' \
  --exclude 'AWS.IdentityCenter*' \
  --exclude 'AWS.Organizations.*'  \
  --exclude 'AWS.IAM.ServiceLinkedRole' \
  --exclude 'AWS.LakeFormation.*' \
  --exclude 'AWS.Notifications.*' \
  --exclude 'AWS.NotificationsContacts.*' \
  --exclude 'AWS.ApiGateway.Account' \
  --concurrency 32 \
  --timeout 300 \
  --filter 'resource.Type === "Cloudflare.Worker" && (resource.workerName?.startsWith("alchemy-state") || resource.workerName === "Api" || ["alchemy-website-preview","alchemy-website-main","alchemy-website-prod"].includes(resource.workerName))' \
  --filter 'resource.Type === "AWS.IAM.Role" && (["alchemy-github-actions", "distilled-github-oidc-role"].includes(resource.roleName) || resource.roleName?.startsWith("AWSReservedSSO"))' \
  --filter 'resource.Type === "AWS.S3.Bucket" && (String(resource.bucketName).startsWith("alchemy-state") || String(resource.bucketName).startsWith("alchemy-assets"))' \
  --filter 'typeof resource.name === "string" && (resource.name.startsWith("DO-NOT-DELETE") || resource.name.startsWith("AppConfig.") || resource.name.startsWith("system_") || ["primary","AwsDataCatalog","DefaultConfiguration","Default","default","open-access","default.dax1.0"].includes(resource.name))' \
  --filter 'resource.Type === "Cloudflare.ApiToken.AccountApiToken" && !(/^(?=.{17,64}$)[A-Za-z0-9-]*-[a-z2-7]{16}$|^[A-Za-z0-9-]{48}[a-z2-7]{16}$/.test(String(resource.name)) || resource.name === "distilled-cf-accounts-empty-policies")' \
  --filter 'resource.Type === "Cloudflare.AI.Gateway" && resource.gatewayId === "default"' \
  --filter 'resource.Type === "Cloudflare.Email.Address" && resource.email === "alchemy-list-test@alchemy-test-2.us"' \
  --filter 'String(resource.logGroupName).startsWith("/aws/vendedlogs/b2bi/")' \
  --filter 'resource.Type === "AWS.Logs.LogGroup" && String(resource.logGroupName).startsWith("/aws-glue/")' \
  --filter 'resource.Type === "Fly.Bucket" && resource.name === "fly-buovnrccm7qpb3be3utsdvlj6x"' \
  --filter 'resource.Type === "GCP.Storage.Bucket" && String(resource.bucketName).startsWith("alchemy-state-")' \
  "$@"
