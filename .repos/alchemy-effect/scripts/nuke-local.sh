# Clears the floci local emulator: enumerates every LOCALLY EMULATED AWS
# resource (`--local`) and deletes it. Only providers registered with both a
# live and a local implementation participate, so the real cloud is never
# touched and no cloud credentials are needed.
#
# `--include 'AWS.*'` keeps the run to floci. Drop it to also sweep the
# Cloudflare local runtime (workerd instances alive in this process — always
# empty from a fresh CLI invocation, so it just costs a build).
#
# --- What is spared, and why -----------------------------------------------
#
# The emulator, like a real account, has always-present singletons. Deleting
# them either fails or is a no-op that re-enumerates on the next run, so a
# run would never converge to "nothing to delete":
#
#   AWS.ApiGateway.Account   account-level settings object; get-account always
#                            answers, so it lists forever
#   AwsDataCatalog           Athena's built-in catalog (delete is rejected)
#   default                  the Scheduler schedule group, the RDS DB subnet
#                            group, and friends — recreated by the emulator
#
# AWS.EC2.SecurityGroupRule is excluded because of a floci bug: deleting a
# security group leaves its rules behind in DescribeSecurityGroupRules, and
# those orphans can never be revoked (RevokeSecurityGroupIngress fails with
# InvalidGroup.NotFound because the group is gone). They accumulate and make
# every run report ~80 rules to delete that "succeed" and come straight back.
# Deleting the group already removes the rules functionally; only the listing
# is dirty. Reproduce with:
#   aws --endpoint-url http://localhost:4566 ec2 describe-security-group-rules
#
# floci's own internals are spared for the same convergence reason:
#   floci-*                    the emulator's internal buckets (Athena results, ...)
#   awslambda-us-east-1-tasks  the emulator's Lambda task store
bun alchemy unsafe nuke ./stacks/nuke.ts \
  --local \
  --include 'AWS.*' \
  --exclude 'AWS.ApiGateway.Account' \
  --exclude 'AWS.EC2.SecurityGroupRule' \
  --concurrency 32 \
  --timeout 60 \
  --filter '["default", "AwsDataCatalog", "primary", "Default", "DefaultConfiguration"].includes(resource.LogicalId)' \
  --filter 'resource.Type === "AWS.S3.Bucket" && (String(resource.bucketName).startsWith("floci-") || String(resource.bucketName) === "awslambda-us-east-1-tasks")' \
  "$@"
