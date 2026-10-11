import type { ModelInvocationContext } from "../contracts.js";
import { awaitCheckpointAdmission } from "../recovery-checkpoint.js";

/** Complete terminal retention before parsing or disposal, without repeating completed admission. */
export async function admitNativeReturn(
  retain: ModelInvocationContext["retainNativeReturn"],
  receipt: Parameters<NonNullable<typeof retain>>[0] | undefined,
  repository: string | undefined,
  checkpointRejected = false,
): Promise<void> {
  const admission = receipt ? await retain?.(receipt) : undefined;
  // Legacy callbacks, absent returns and failure paths keep their existing gate.
  // A rejected checkpoint remains its original fence, never a second submission.
  if (!checkpointRejected && admission !== "admission-complete")
    await awaitCheckpointAdmission(repository, "explicit");
}
