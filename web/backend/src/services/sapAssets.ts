// Downloads the Apple binaries the browser-side SAP signer runs under
// emulation, straight from Apple's software update CDN.
//
// They live inside a 2013 OS X update package: a xar container holding a
// bzip2-compressed cpio archive. Only four files out of it are wanted and the
// package is far larger than they are, so this reads it with range requests
// and stops as soon as it has them, the way ipatool's internal/sap/assets
// does.
//
// The result is written to DATA_DIR/sap and reused forever after — the files
// come from a fixed release and never change. Each is checked against its
// SHA-256 before being kept.

import { createHash } from "crypto";
import { mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { inflateSync } from "zlib";
import unbzip2 from "unbzip2-stream";
import { config } from "../config.js";

const UPDATE_URL =
  "https://swcdn.apple.com/content/downloads/27/34/041-98128-A_SYPWICN3KH/5dqkl4rqgbsr18yzy61yeie9g3cmjc5hiv/OSXUpd10.9.pkg";

// Where the bzip2 stream resumes inside the payload, and how far past the
// start of the decompressed data the cpio archive begins. Both are properties
// of this particular package.
const PAYLOAD_BZ_OFFSET = 0x352f40d5;
const PAYLOAD_CPIO_SKIP = 0x3a4;

const XAR_MAGIC = 0x78617221; // "xar!"

interface AssetSpec {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export const REQUIRED_ASSETS: AssetSpec[] = [
  {
    name: "CommerceKit",
    path: "./System/Library/PrivateFrameworks/CommerceKit.framework/Versions/A/CommerceKit",
    size: 3271840,
    sha256: "b84ff12c21987856c0a17b78f1ad82b73195a6dec5f3b208a17d245555a2c8a2",
  },
  {
    name: "CommerceCore",
    path: "./System/Library/PrivateFrameworks/CommerceKit.framework/Versions/A/Frameworks/CommerceCore.framework/Versions/A/CommerceCore",
    size: 207744,
    sha256: "c5401e57402230f3c876409d295319ddf1e61287bc882683c5d61277be7bc1f2",
  },
  {
    name: "CoreFP",
    path: "./System/Library/PrivateFrameworks/CoreFP.framework/Versions/A/CoreFP",
    size: 29014912,
    sha256: "f19141336be4198d0f8991bb00017c915efc7aeaece36c345f7faa1237ea6074",
  },
  {
    name: "CoreFP.icxs",
    path: "./System/Library/PrivateFrameworks/CoreFP.framework/Versions/A/CoreFP.icxs",
    size: 5288352,
    sha256: "473e78af86979f5bd4f6269561caf770b3d16c098d918846eeac8cdd2fe6566a",
  },
];

/**
 * Where the four Apple binaries are read from.
 *
 * `SAP_ASSETS_DIR` overrides it for deployments that cannot reach
 * swcdn.apple.com — a Space behind an egress filter, a host in a region where
 * Apple's CDN is unreliable — where the files have to be copied in by hand
 * instead of downloaded. Point it at a persistent volume, or the files are
 * gone on every restart and sign-in breaks again.
 */
export function assetDirectory(): string {
  return config.sapAssetsDir || path.join(config.dataDir, "sap");
}

const MANIFEST_NAME = "sap-assets.json";

// Reading and parsing the manifest on every poll of the status endpoint would
// be waste, so the result is kept until the file changes.
let manifestCache: { dir: string; mtimeMs: number; assets: AssetSpec[] } | null =
  null;

/**
 * The assets the signer needs.
 *
 * `sap-assets.json` alongside the binaries overrides the built-in list. That
 * is how a deployment supplies a different build — a newer OS X update, a
 * mirror repacked elsewhere — without a code change, and it is what lets the
 * verification below be exercised without 38 MB of Apple's binaries.
 */
export async function requiredAssets(): Promise<AssetSpec[]> {
  const dir = assetDirectory();
  const file = path.join(dir, MANIFEST_NAME);

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch {
    manifestCache = null;
    return REQUIRED_ASSETS;
  }

  if (
    manifestCache &&
    manifestCache.dir === dir &&
    manifestCache.mtimeMs === info.mtimeMs
  ) {
    return manifestCache.assets;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${file} must be a non-empty array of asset descriptors`);
  }

  const assets = parsed.map((entry, index) => {
    const item = entry as Partial<AssetSpec>;
    if (!item.name || !item.path || !item.sha256) {
      throw new Error(`${file} entry ${index} needs name, path and sha256`);
    }
    return {
      name: item.name,
      path: item.path,
      size: Number(item.size ?? 0),
      sha256: item.sha256,
    };
  });

  manifestCache = { dir, mtimeMs: info.mtimeMs, assets };
  return assets;
}

/**
 * What to do when the assets are not there and cannot be fetched. Names every
 * file with its exact size and digest, so whoever is copying them in by hand
 * can tell a short or corrupted copy from a wrong one.
 */
export async function manualInstallHint(missing: string[]): Promise<string> {
  const wanted = (await requiredAssets()).filter((asset) =>
    missing.includes(asset.name),
  );
  const listing = wanted
    .map((asset) => `  ${asset.name}  ${asset.size} bytes  sha256:${asset.sha256}`)
    .join("\n");
  return (
    `Place these files in ${assetDirectory()} (or run tools/fetch-sap-assets.mjs ` +
    `somewhere that can reach swcdn.apple.com and copy them over):\n${listing}`
  );
}

export type AssetState = "ok" | "missing" | "corrupt";

// Digesting 38 MB on every request would be wasteful, and these files never
// change once written, so a verdict is kept until the file does. Size and
// modification time are enough to notice a replacement.
const verdicts = new Map<string, { size: number; mtimeMs: number; state: AssetState }>();

/**
 * Checks one asset against its recorded size and digest.
 *
 * The size alone is not enough: a file of the right length but wrong contents
 * loads fine and then fails somewhere deep inside the emulator, with nothing
 * to connect the fault back to a bad download.
 */
export async function verifyAsset(spec: AssetSpec): Promise<AssetState> {
  const file = path.join(assetDirectory(), spec.name);

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch {
    verdicts.delete(spec.name);
    return "missing";
  }

  const cached = verdicts.get(spec.name);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return cached.state;
  }

  let state: AssetState = "corrupt";
  if (info.size === spec.size) {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    state = digest === spec.sha256 ? "ok" : "corrupt";
  }

  if (state === "corrupt") {
    console.error(
      `SAP assets: ${spec.name} is ${info.size} bytes and does not match its digest`,
    );
  }

  verdicts.set(spec.name, { size: info.size, mtimeMs: info.mtimeMs, state });
  return state;
}

/** Verifies every asset, reporting which are usable and which are not. */
export async function verifyAssets(): Promise<{
  ok: string[];
  missing: string[];
  corrupt: string[];
}> {
  const ok: string[] = [];
  const missing: string[] = [];
  const corrupt: string[] = [];

  for (const spec of await requiredAssets()) {
    const state = await verifyAsset(spec);
    if (state === "ok") ok.push(spec.name);
    else if (state === "missing") missing.push(spec.name);
    else corrupt.push(spec.name);
  }

  return { ok, missing, corrupt };
}

async function range(start: number, end?: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(UPDATE_URL, {
      headers: { Range: `bytes=${start}-${end ?? ""}` },
    });
  } catch (error) {
    // Node reports a failed fetch as a bare "fetch failed" and keeps the
    // reason — DNS, refused, TLS — on .cause. Without unwrapping it, an
    // operator whose host cannot reach Apple's CDN gets two useless words and
    // no idea there is another way to get the files in.
    const cause = error instanceof Error ? error.cause : undefined;
    throw new Error(
      `cannot reach swcdn.apple.com to download the SAP assets` +
        (cause ? `: ${cause instanceof Error ? cause.message : String(cause)}` : "") +
        `.\nIf this host's egress is restricted, run tools/fetch-sap-assets.mjs ` +
        `somewhere that can reach Apple, copy the directory over, and set ` +
        `SAP_ASSETS_DIR to where you put it.`,
    );
  }

  if (response.status !== 206 && response.status !== 200) {
    throw new Error(`Apple returned ${response.status} for the update package`);
  }

  return response;
}

/** Locates the Payload member inside the xar container. */
async function locatePayload(): Promise<{ offset: number; length: number }> {
  const head = Buffer.from(await (await range(0, 27)).arrayBuffer());
  if (head.readUInt32BE(0) !== XAR_MAGIC) {
    throw new Error("Apple update package is not a xar archive");
  }

  const headerSize = head.readUInt16BE(4);
  const tocCompressed = Number(head.readBigUInt64BE(8));

  const tocRaw = Buffer.from(
    await (await range(headerSize, headerSize + tocCompressed - 1)).arrayBuffer(),
  );
  const toc = inflateSync(tocRaw).toString("utf8");

  // The table of contents is XML; the Payload's entry carries the offset and
  // length of its bytes within the heap that follows the contents.
  const entry = /<file[^>]*>(?:(?!<\/file>)[\s\S])*?<name>Payload<\/name>[\s\S]*?<\/file>/.exec(toc);
  if (!entry) throw new Error("Apple update package has no Payload member");

  const offset = /<offset>(\d+)<\/offset>/.exec(entry[0]);
  const length = /<length>(\d+)<\/length>/.exec(entry[0]);
  if (!offset || !length) {
    throw new Error("Apple update package Payload has no extent");
  }

  return {
    offset: headerSize + tocCompressed + Number(offset[1]),
    length: Number(length[1]),
  };
}

/**
 * Reads the old portable ASCII cpio format Apple's payload uses, handing each
 * entry to `onEntry` and stopping as soon as it returns false.
 */
async function readCpio(
  stream: AsyncIterable<Buffer>,
  onEntry: (name: string, body: Buffer) => boolean,
): Promise<void> {
  const HEADER = 76;
  let buffer = Buffer.alloc(0);
  let done = false;

  for await (const chunk of stream) {
    if (done) break;
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      if (buffer.length < HEADER) break;
      if (buffer.subarray(0, 6).toString("ascii") !== "070707") {
        throw new Error("Apple payload is not a portable ASCII cpio archive");
      }

      const nameSize = parseInt(buffer.subarray(59, 65).toString("ascii"), 8);
      const fileSize = parseInt(buffer.subarray(65, 76).toString("ascii"), 8);
      if (!Number.isFinite(nameSize) || !Number.isFinite(fileSize)) {
        throw new Error("Apple payload has an unreadable cpio header");
      }

      const total = HEADER + nameSize + fileSize;
      if (buffer.length < total) break;

      const name = buffer.subarray(HEADER, HEADER + nameSize - 1).toString("ascii");
      if (name === "TRAILER!!!") {
        done = true;
        break;
      }

      const body = buffer.subarray(HEADER + nameSize, total);
      if (!onEntry(name, body)) {
        done = true;
        break;
      }

      buffer = buffer.subarray(total);
    }
  }
}

export interface FetchProgress {
  stage: "locating" | "downloading" | "verifying" | "done";
  found: string[];
}

/**
 * Downloads and extracts the assets into DATA_DIR/sap. Files already present
 * and the right size are left alone, so this is safe to call repeatedly.
 */
export async function fetchAssets(
  onProgress?: (progress: FetchProgress) => void,
): Promise<string[]> {
  const required = await requiredAssets();
  const target = assetDirectory();
  await mkdir(target, { recursive: true });

  // Anything already present and verified is left alone; a corrupt file is
  // replaced rather than skipped, which is the whole point of checking the
  // digest rather than the size.
  const existing = await verifyAssets();
  if (existing.ok.length === required.length) {
    onProgress?.({ stage: "done", found: existing.ok });
    return existing.ok;
  }

  // With SAP_ASSETS_DIR set the operator has said the files come from
  // somewhere else. Downloading anyway would either fail on a host they
  // cannot reach or quietly write over a directory they manage by hand.
  if (config.sapAssetsDir) {
    throw new Error(
      `SAP_ASSETS_DIR is set to ${config.sapAssetsDir}, so the assets are ` +
        `expected to be supplied rather than downloaded.\n` +
        await manualInstallHint([...existing.missing, ...existing.corrupt]),
    );
  }

  if (existing.corrupt.length) {
    console.warn(`SAP assets: replacing corrupt ${existing.corrupt.join(", ")}`);
  }

  onProgress?.({ stage: "locating", found: [] });
  const payload = await locatePayload();

  onProgress?.({ stage: "downloading", found: [] });
  const response = await range(
    payload.offset + PAYLOAD_BZ_OFFSET,
    payload.offset + payload.length - 1,
  );
  if (!response.body) throw new Error("Apple returned an empty payload stream");

  // The range starts mid-stream at a block boundary, so the bzip2 header has
  // to be put back in front of it.
  const compressed = Readable.from(
    (async function* () {
      yield Buffer.from("BZh9", "ascii");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const chunk of response.body as any) yield Buffer.from(chunk);
    })(),
  );

  const wanted = new Map(required.map((asset) => [asset.path, asset]));
  const found: string[] = [];
  const pending = new Map<string, Buffer>();

  // unbzip2-stream is built on `through`, so it hands back an old-style
  // stream that cannot be iterated; wrap turns it into one that can.
  const decompressed = new Readable({ read() {} }).wrap(
    compressed.pipe(unbzip2()),
  );

  let skipped = 0;
  const archive = Readable.from(
    (async function* () {
      for await (const chunk of decompressed) {
        let block = Buffer.from(chunk);
        if (skipped < PAYLOAD_CPIO_SKIP) {
          const drop = Math.min(PAYLOAD_CPIO_SKIP - skipped, block.length);
          skipped += drop;
          block = block.subarray(drop);
          if (block.length === 0) continue;
        }
        yield block;
      }
    })(),
  );

  await readCpio(archive as AsyncIterable<Buffer>, (name, body) => {
    const asset = wanted.get(name);
    if (asset) {
      pending.set(asset.name, Buffer.from(body));
      found.push(asset.name);
      onProgress?.({ stage: "downloading", found: [...found] });
    }
    return pending.size < wanted.size;
  });

  onProgress?.({ stage: "verifying", found: [...found] });

  const written: string[] = [];
  for (const asset of required) {
    const body = pending.get(asset.name);
    if (!body) continue;

    if (body.length !== asset.size) {
      throw new Error(
        `${asset.name} is ${body.length} bytes, expected ${asset.size}`,
      );
    }

    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error(`${asset.name} failed its digest check`);
    }

    // Written aside then renamed, so a partial file is never served.
    const destination = path.join(target, asset.name);
    const temporary = `${destination}.partial`;
    await writeFile(temporary, body);
    await rename(temporary, destination);
    written.push(asset.name);
  }

  if (written.length !== required.length) {
    const missing = required.filter(
      (asset) => !written.includes(asset.name),
    ).map((asset) => asset.name);
    throw new Error(`Apple payload did not contain ${missing.join(", ")}`);
  }

  onProgress?.({ stage: "done", found: written });
  return written;
}
