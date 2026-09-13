/**
 * Marker baked into the EC2 instance's hosted program. The stress suite
 * rewrites it to prove the hosted-runtime update path: re-bundle, re-upload
 * to (emulated) S3, and an in-place reboot that picks the new bundle up —
 * same instance id, same address, new code.
 */
export const EC2_MARKER = "ec2-v1";
