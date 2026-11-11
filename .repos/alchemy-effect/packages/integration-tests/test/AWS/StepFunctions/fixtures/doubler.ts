/**
 * Plain async Lambda handler invoked by the compiled Step Functions
 * program fixture: doubles `value`.
 */
export const handler = async (event: { value?: number }) => ({
  doubled: (event.value ?? 0) * 2,
});
