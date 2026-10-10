import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ContentRef,
  ContentStore,
  ValidationCommandReceipt,
} from "./contracts.js";
import { pinnedGitRaw } from "./process.js";
import { refuseUnknownFields } from "./unknown-fields.js";

export const MAX_REVIEW_RECEIPT_BYTES = 1024 * 1024;
export const MAX_REVIEW_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_REVIEW_IMAGES = 8;
export const MAX_REVIEW_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
export interface ReviewArtifactSelector {
  command: string;
  receipt: {
    stdoutPathField: string;
    stdoutSha256Field: string;
    maxBytes: number;
  };
  image: { file: string; sha256Field: string; maxBytes: number };
  candidate: { file: string; sha256Field: string };
}
export interface ReviewArtifactEvidence {
  selectorIndex: number;
  commandIndex: number;
  command: string;
  treeSha: string;
  candidate: { path: string; sha256: string };
  receipt: { path: string; ref: ContentRef };
  image: { path: string; ref: ContentRef };
  complete: true;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Review artifact declaration or evidence must be an object",
    );
  return value as Record<string, unknown>;
}
function path(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error("Review artifact path must be contained and relative");
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Review artifact SHA-256 is invalid");
}
function field(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error(
      "Review artifact selector requires a direct JSON field identifier",
    );
}
function bound(value: unknown, maximum: number): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  )
    throw new Error("Review artifact byte bound is invalid");
}
export function assertReviewArtifactSelectors(
  value: unknown,
): asserts value is ReviewArtifactSelector[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 8)
    throw new Error(
      "reviewArtifacts must contain at most eight explicit selectors",
    );
  const identities = new Set<string>();
  for (const raw of value) {
    const selector = object(raw);
    refuseUnknownFields(
      selector,
      ["command", "receipt", "image", "candidate"],
      "review artifact selector",
    );
    if (
      typeof selector.command !== "string" ||
      !selector.command.trim() ||
      selector.command.includes("\n") ||
      selector.command.includes("\r")
    )
      throw new Error("Review artifact command is invalid");
    const receipt = object(selector.receipt),
      image = object(selector.image),
      candidate = object(selector.candidate);
    refuseUnknownFields(
      receipt,
      ["stdoutPathField", "stdoutSha256Field", "maxBytes"],
      "review artifact receipt",
    );
    refuseUnknownFields(
      image,
      ["file", "sha256Field", "maxBytes"],
      "review artifact image",
    );
    refuseUnknownFields(
      candidate,
      ["file", "sha256Field"],
      "review artifact candidate",
    );
    field(receipt.stdoutPathField);
    field(receipt.stdoutSha256Field);
    field(image.sha256Field);
    field(candidate.sha256Field);
    path(image.file);
    path(candidate.file);
    bound(receipt.maxBytes, MAX_REVIEW_RECEIPT_BYTES);
    bound(image.maxBytes, MAX_REVIEW_IMAGE_BYTES);
    const identity = JSON.stringify([
      selector.command,
      receipt.stdoutPathField,
      image.file,
    ]);
    if (identities.has(identity))
      throw new Error("Review artifact selectors duplicate an output");
    identities.add(identity);
  }
}
function ref(value: unknown, mediaType: string, maximum: number): void {
  const reference = object(value);
  refuseUnknownFields(
    reference,
    ["digest", "bytes", "mediaType"],
    "review artifact content reference",
  );
  digest(reference.digest);
  bound(reference.bytes, maximum);
  if (reference.mediaType !== mediaType)
    throw new Error("Review artifact content MIME is invalid");
}
export function assertReviewArtifacts(
  value: unknown,
  treeSha: string,
  commands: readonly ValidationCommandReceipt[],
): asserts value is ReviewArtifactEvidence[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_REVIEW_IMAGES)
    throw new Error("Retained review artifacts are invalid");
  const identities = new Set<string>();
  let totalImageBytes = 0;
  for (const raw of value) {
    const artifact = object(raw);
    refuseUnknownFields(
      artifact,
      [
        "selectorIndex",
        "commandIndex",
        "command",
        "treeSha",
        "candidate",
        "receipt",
        "image",
        "complete",
      ],
      "retained review artifact",
    );
    if (
      !Number.isSafeInteger(artifact.selectorIndex) ||
      (artifact.selectorIndex as number) < 0 ||
      (artifact.selectorIndex as number) >= 8 ||
      !Number.isSafeInteger(artifact.commandIndex) ||
      (artifact.commandIndex as number) < 0 ||
      artifact.complete !== true ||
      artifact.treeSha !== treeSha
    )
      throw new Error("Retained review artifact identity is invalid");
    const command = commands[artifact.commandIndex as number];
    if (
      !command ||
      command.index !== artifact.commandIndex ||
      command.command !== artifact.command ||
      command.treeSha !== treeSha ||
      !command.passed ||
      command.exitCode !== 0
    )
      throw new Error(
        "Retained review artifact lacks its passing exact command",
      );
    const candidate = object(artifact.candidate),
      receipt = object(artifact.receipt),
      image = object(artifact.image);
    refuseUnknownFields(
      candidate,
      ["path", "sha256"],
      "retained review artifact candidate",
    );
    for (const entry of [receipt, image])
      refuseUnknownFields(
        entry,
        ["path", "ref"],
        "retained review artifact object",
      );
    path(candidate.path);
    digest(candidate.sha256);
    path(receipt.path);
    path(image.path);
    ref(receipt.ref, "application/json", MAX_REVIEW_RECEIPT_BYTES);
    ref(image.ref, "image/png", MAX_REVIEW_IMAGE_BYTES);
    totalImageBytes += (image.ref as ContentRef).bytes;
    if (totalImageBytes > MAX_REVIEW_TOTAL_IMAGE_BYTES)
      throw new Error(
        "Retained review images exceed their aggregate byte bound",
      );
    const identity = `${artifact.selectorIndex}:${artifact.commandIndex}`;
    if (identities.has(identity))
      throw new Error("Retained review artifact identity is duplicated");
    identities.add(identity);
  }
}
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

/** Verify a complete PNG container, including chunk lengths and CRCs; no visual acceptance is inferred. */
export function assertReviewImageBytes(bytes: Buffer): void {
  if (
    bytes.length > MAX_REVIEW_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Review artifact is not a bounded PNG");
  let offset = 8,
    header = false,
    data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) break;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++) {
      crc = (crc >>> 8) ^ pngCrcTable[(crc ^ bytes[i]!) & 255]!;
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(end - 4))
      throw new Error("Review artifact PNG chunk checksum is invalid");
    if (!header) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        bytes.readUInt32BE(offset + 8) === 0 ||
        bytes.readUInt32BE(offset + 12) === 0
      )
        throw new Error("Review artifact PNG header is invalid");
      header = true;
    } else if (type === "IHDR")
      throw new Error("Review artifact PNG header is duplicated");
    if (type === "IDAT") data = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !data)
        throw new Error("Review artifact PNG is incomplete");
      return;
    }
    offset = end;
  }
  throw new Error("Review artifact PNG is incomplete");
}
function readContained(
  root: string,
  relativePath: string,
  maximum: number,
): Buffer {
  path(relativePath);
  const base = resolve(root);
  if (realpathSync(base) !== base || !lstatSync(base).isDirectory())
    throw new Error("Review artifact root is not a regular directory");
  let current = base;
  for (const [index, part] of relativePath.split("/").entries()) {
    current = join(current, part);
    const entry = lstatSync(current);
    if (
      entry.isSymbolicLink() ||
      (index < relativePath.split("/").length - 1
        ? !entry.isDirectory()
        : !entry.isFile())
    )
      throw new Error("Review artifact path is not a regular contained file");
  }
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > maximum ||
      realpathSync(current) !== current
    )
      throw new Error(
        "Review artifact file exceeds its bound or path identity",
      );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (
      offset !== stat.size ||
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      fstatSync(fd).size !== stat.size
    )
      throw new Error("Review artifact file changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function retain(
  store: ContentStore,
  bytes: Buffer,
  mediaType: string,
): Promise<ContentRef> {
  const reference = await store.put(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { mediaType },
  );
  if (
    reference.digest !== hash(bytes) ||
    reference.bytes !== bytes.length ||
    reference.mediaType !== mediaType
  )
    throw new Error("Review artifact content retention changed its identity");
  await store.verify(reference);
  return reference;
}
export async function captureReviewArtifacts(args: {
  worktree: string;
  treeSha: string;
  commandIndex: number;
  command: string;
  stdout: string;
  selectors: readonly ReviewArtifactSelector[];
  contentStore: ContentStore;
}): Promise<ReviewArtifactEvidence[]> {
  const artifacts: ReviewArtifactEvidence[] = [];
  for (const [selectorIndex, selector] of args.selectors.entries()) {
    if (selector.command !== args.command) continue;
    const line = args.stdout.trimEnd().split(/\r?\n/).at(-1);
    if (!line || Buffer.byteLength(line) > MAX_REVIEW_RECEIPT_BYTES)
      throw new Error(
        "Review artifact command lacks a bounded terminal JSON receipt locator",
      );
    const locator = object(JSON.parse(line));
    const receiptPath = locator[selector.receipt.stdoutPathField];
    path(receiptPath);
    const receiptDigest = locator[selector.receipt.stdoutSha256Field];
    digest(receiptDigest);
    const receiptBytes = readContained(
      args.worktree,
      receiptPath,
      selector.receipt.maxBytes,
    );
    if (hash(receiptBytes) !== receiptDigest)
      throw new Error(
        "Review artifact receipt digest differs from command stdout",
      );
    if (!Buffer.from(receiptBytes.toString("utf8")).equals(receiptBytes))
      throw new Error("Review artifact receipt is not complete UTF-8 JSON");
    const receipt = object(JSON.parse(receiptBytes.toString("utf8")));
    const candidateDigest = receipt[selector.candidate.sha256Field];
    digest(candidateDigest);
    const entry = pinnedGitRaw(
      args.worktree,
      "--literal-pathspecs",
      "ls-tree",
      "-z",
      args.treeSha,
      "--",
      selector.candidate.file,
    ).toString("utf8");
    if (
      !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry) ||
      entry.slice(0, -1).split("\t")[1] !== selector.candidate.file ||
      !entry.endsWith("\0")
    )
      throw new Error(
        "Review artifact candidate is not a tracked regular file in the exact tree",
      );
    const candidate = pinnedGitRaw(
      args.worktree,
      "show",
      `${args.treeSha}:${selector.candidate.file}`,
    );
    const checkoutCandidate = readContained(
      args.worktree,
      selector.candidate.file,
      Math.max(candidate.length, 1),
    );
    if (
      !candidate.equals(checkoutCandidate) ||
      hash(candidate) !== candidateDigest
    )
      throw new Error(
        "Review artifact receipt does not bind the unchanged exact candidate bytes",
      );
    const imagePath =
      dirname(receiptPath) === "."
        ? selector.image.file
        : `${dirname(receiptPath)}/${selector.image.file}`;
    const imageDigest = receipt[selector.image.sha256Field];
    digest(imageDigest);
    const imageBytes = readContained(
      args.worktree,
      imagePath,
      selector.image.maxBytes,
    );
    if (hash(imageBytes) !== imageDigest)
      throw new Error(
        "Review artifact image digest differs from its execution receipt",
      );
    assertReviewImageBytes(imageBytes);
    artifacts.push({
      selectorIndex,
      commandIndex: args.commandIndex,
      command: args.command,
      treeSha: args.treeSha,
      candidate: { path: selector.candidate.file, sha256: candidateDigest },
      receipt: {
        path: receiptPath,
        ref: await retain(args.contentStore, receiptBytes, "application/json"),
      },
      image: {
        path: imagePath,
        ref: await retain(args.contentStore, imageBytes, "image/png"),
      },
      complete: true,
    });
  }
  return artifacts;
}
