// AWS-owned SageMaker scikit-learn serving images (per-region registries).
// CreateModel performs a real pull-permission check, so test models must
// reference an image that actually exists and that the execution role (with
// AmazonEC2ContainerRegistryReadOnly) can pull.
export const sklearnImage = (region: string) => {
  const registries: Record<string, string> = {
    "us-east-1": "683313688378",
    "us-east-2": "257758044811",
    "us-west-1": "746614075791",
    "us-west-2": "246618743249",
  };
  const registry = registries[region];
  if (!registry) {
    throw new Error(`no sklearn registry mapped for region ${region}`);
  }
  return `${registry}.dkr.ecr.${region}.amazonaws.com/sagemaker-scikit-learn:1.2-1`;
};
