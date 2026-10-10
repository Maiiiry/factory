import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContentRef,
  ContentStore,
  ReviewImageInput,
  ResultReviewEvidenceSource,
} from "./contracts.js";
import { pinnedGitRaw } from "./process.js";
import {
  assertReviewArtifacts,
  assertReviewImageBytes,
  MAX_REVIEW_IMAGES,
  MAX_REVIEW_TOTAL_IMAGE_BYTES,
  type ReviewArtifactEvidence,
} from "./review-artifacts.js";
import type { ValidationEvidence } from "./validation-evidence.js";

interface LoadedReviewArtifact {
  identity: ReviewArtifactEvidence;
  evidencePath: string;
  receiptBytes: Buffer;
  imageBytes: Buffer;
}

async function bytes(store: ContentStore, ref: ContentRef): Promise<Buffer> {
  const reader = (await store.open(ref)).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > ref.bytes)
        throw new Error(
          "Retained review artifact exceeds its complete byte identity",
        );
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const result = Buffer.concat(chunks);
  if (
    result.length !== ref.bytes ||
    createHash("sha256").update(result).digest("hex") !== ref.digest
  )
    throw new Error(
      "Retained review artifact bytes differ from their complete identity",
    );
  return result;
}

/** Load retained observations, never reconstruct an output deleted with a checkout. */
export async function loadReviewArtifacts(
  checkout: string,
  evidence: ValidationEvidence,
  store?: ContentStore,
): Promise<LoadedReviewArtifact[]> {
  assertReviewArtifacts(
    evidence.reviewArtifacts,
    evidence.treeSha,
    evidence.commands,
  );
  if (!evidence.reviewArtifacts?.length) return [];
  if (!store)
    throw new Error(
      "Retained review images require their configured content store",
    );
  const loaded: LoadedReviewArtifact[] = [];
  let totalImageBytes = 0;
  for (const [index, identity] of evidence.reviewArtifacts.entries()) {
    totalImageBytes += identity.image.ref.bytes;
    if (
      index >= MAX_REVIEW_IMAGES ||
      totalImageBytes > MAX_REVIEW_TOTAL_IMAGE_BYTES
    )
      throw new Error(
        "Retained review image input exceeds the finite request bound",
      );
    const candidate = pinnedGitRaw(
      checkout,
      "show",
      `${evidence.treeSha}:${identity.candidate.path}`,
    );
    if (
      createHash("sha256").update(candidate).digest("hex") !==
      identity.candidate.sha256
    )
      throw new Error(
        "Retained review image candidate bytes differ from the exact review tree",
      );
    const receiptBytes = await bytes(store, identity.receipt.ref);
    const text = receiptBytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(receiptBytes))
      throw new Error("Retained review receipt is not complete UTF-8 JSON");
    const receipt = JSON.parse(text) as unknown;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      throw new Error("Retained review receipt is not an object");
    const imageBytes = await bytes(store, identity.image.ref);
    assertReviewImageBytes(imageBytes);
    loaded.push({
      identity,
      evidencePath: `artifacts/${index}.png`,
      receiptBytes,
      imageBytes,
    });
  }
  return loaded;
}

/** Literal identity citations accompany pixels; identities do not prove visual semantics. */
export function reviewArtifactEvidence(
  artifacts: LoadedReviewArtifact[],
): ResultReviewEvidenceSource[] {
  return artifacts.flatMap(({ identity, evidencePath, receiptBytes }) => [
    {
      path: evidencePath,
      complete: true,
      content: JSON.stringify({
        purpose:
          "Direct image observation from the exact passed validation command; visual semantics require inspecting the supplied image",
        ...identity,
      }),
    },
    {
      path: `${evidencePath} receipt`,
      complete: true,
      content: receiptBytes.toString("utf8"),
    },
  ]);
}

/** Export only already authenticated retained bytes into the existing read-only review workspace. */
export function materializeReviewImages(
  root: string,
  artifacts: LoadedReviewArtifact[],
): ReviewImageInput[] {
  if (!artifacts.length) return [];
  const directory = join(root, "artifacts");
  mkdirSync(directory, { mode: 0o700 });
  return artifacts.map(({ identity, evidencePath, imageBytes }, index) => {
    const path = join(directory, `${index}.png`);
    writeFileSync(path, imageBytes, { flag: "wx", mode: 0o400 });
    if (!readFileSync(path).equals(imageBytes))
      throw new Error("Materialized review image bytes differ");
    return {
      path,
      mediaType: "image/png",
      bytes: imageBytes.length,
      digest: identity.image.ref.digest,
      evidencePath,
    };
  });
}
