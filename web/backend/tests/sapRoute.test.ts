import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "crypto";
import { mkdtemp, writeFile, rm, utimes } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// The four real binaries are 38 MB and come from Apple's CDN, which is not
// reachable from every build machine. What is under test here is the
// bookkeeping around them — size and digest checks, what the endpoints answer
// when a file is absent or wrong — and none of that cares what the bytes are.
// A sap-assets.json manifest describes small stand-ins instead, which is the
// same mechanism an operator uses to supply a different build.
const STAND_INS = [
  { name: "CommerceKit", path: "./System/Library/PrivateFrameworks/CommerceKit.framework/Versions/A/CommerceKit", body: "commerce-kit" },
  { name: "CommerceCore", path: "./System/Library/PrivateFrameworks/CommerceKit.framework/Versions/A/Frameworks/CommerceCore.framework/Versions/A/CommerceCore", body: "commerce-core" },
  { name: "CoreFP", path: "./System/Library/PrivateFrameworks/CoreFP.framework/Versions/A/CoreFP", body: "core-fp" },
  { name: "CoreFP.icxs", path: "./System/Library/PrivateFrameworks/CoreFP.framework/Versions/A/CoreFP.icxs", body: "core-fp-icxs" },
];

const SPECS = STAND_INS.map((asset) => ({
  name: asset.name,
  path: asset.path,
  size: Buffer.byteLength(asset.body),
  sha256: createHash("sha256").update(asset.body).digest("hex"),
}));

const bodies = Object.fromEntries(STAND_INS.map((a) => [a.name, a.body]));
const specOf = (name: string) => SPECS.find((s) => s.name === name)!;

let dir: string;

async function loadModules(manifest: unknown = SPECS, raw?: string) {
  if (raw !== undefined) {
    await writeFile(path.join(dir, "sap-assets.json"), raw);
  } else if (manifest !== null) {
    await writeFile(path.join(dir, "sap-assets.json"), JSON.stringify(manifest));
  }
  vi.resetModules();
  const routes = (await import("../src/routes/sap.js")).default;
  const service = await import("../src/services/sapAssets.js");
  const app = express();
  app.use("/api", routes);
  return { app, service };
}

const writeAsset = (name: string, body: string) =>
  writeFile(path.join(dir, name), body);

describe("SAP asset verification", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "asspp-sap-"));
    process.env.SAP_ASSETS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.SAP_ASSETS_DIR;
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads from SAP_ASSETS_DIR rather than DATA_DIR/sap", async () => {
    const { service } = await loadModules();
    expect(service.assetDirectory()).toBe(dir);
  });

  it("prefers the manifest next to the binaries over the built-in list", async () => {
    const { service } = await loadModules();
    const assets = await service.requiredAssets();

    expect(assets).toEqual(SPECS);
    expect(service.REQUIRED_ASSETS).not.toEqual(SPECS);
  });

  it("falls back to the built-in list when there is no manifest", async () => {
    const { service } = await loadModules(null);
    expect(await service.requiredAssets()).toEqual(service.REQUIRED_ASSETS);
    expect(service.REQUIRED_ASSETS).toHaveLength(4);
  });

  it("rejects a manifest that is not usable, naming the file", async () => {
    // Each case needs a fresh module: the parsed manifest is cached until the
    // file changes, which is what keeps the status endpoint cheap to poll.
    // Written raw, not through JSON.stringify: a stringified string is valid
    // JSON, and would test the array check rather than the parse.
    let { service } = await loadModules(null, "{ not json");
    await expect(service.requiredAssets()).rejects.toThrow(
      /sap-assets\.json is not valid JSON/,
    );

    vi.resetModules();
    ({ service } = await loadModules([]));
    await expect(service.requiredAssets()).rejects.toThrow(/non-empty array/);

    vi.resetModules();
    ({ service } = await loadModules([{ name: "x" }]));
    await expect(service.requiredAssets()).rejects.toThrow(
      /entry 0 needs name, path and sha256/,
    );
  });

  it("reports every asset missing before anything is installed", async () => {
    const { service } = await loadModules();
    const result = await service.verifyAssets();

    expect(result.ok).toEqual([]);
    expect(result.missing.sort()).toEqual(SPECS.map((a) => a.name).sort());
    expect(result.corrupt).toEqual([]);
  });

  it("accepts a file whose size and digest both match", async () => {
    await writeAsset("CommerceKit", bodies.CommerceKit);

    const { service } = await loadModules();
    const result = await service.verifyAssets();

    expect(result.ok).toEqual(["CommerceKit"]);
    expect(result.missing).toHaveLength(SPECS.length - 1);
  });

  it("rejects a file of the right length but wrong contents", async () => {
    // Same byte count, different bytes: the case a size-only check would wave
    // through and the emulator would then fail on with nothing pointing here.
    const impostor = "x".repeat(specOf("CommerceKit").size);
    expect(Buffer.byteLength(impostor)).toBe(specOf("CommerceKit").size);
    await writeAsset("CommerceKit", impostor);

    const { service } = await loadModules();
    const result = await service.verifyAssets();

    expect(result.ok).toEqual([]);
    expect(result.corrupt).toEqual(["CommerceKit"]);
  });

  it("reports a short file as corrupt rather than missing", async () => {
    await writeAsset("CoreFP", "trunc");

    const { service } = await loadModules();
    const result = await service.verifyAssets();

    expect(result.missing).not.toContain("CoreFP");
    expect(result.corrupt).toContain("CoreFP");
  });

  it("re-checks a file once it is replaced", async () => {
    const { service } = await loadModules();
    expect((await service.verifyAssets()).corrupt).toEqual([]);

    await writeAsset("CommerceCore", "wrong bytes but different length");
    expect((await service.verifyAssets()).corrupt).toContain("CommerceCore");

    await writeAsset("CommerceCore", bodies.CommerceCore);
    const after = await service.verifyAssets();
    expect(after.corrupt).toEqual([]);
    expect(after.ok).toContain("CommerceCore");
  });

  it("notices a manifest edited in place", async () => {
    const { service } = await loadModules();
    expect(await service.requiredAssets()).toEqual(SPECS);

    const edited = SPECS.slice(0, 1);
    await writeFile(path.join(dir, "sap-assets.json"), JSON.stringify(edited));
    // Same size, so mtime is what has to catch this.
    const future = new Date(Date.now() + 5000);
    await utimes(path.join(dir, "sap-assets.json"), future, future);

    expect(await service.requiredAssets()).toEqual(edited);
  });

  it("refuses to download over a directory the operator supplies", async () => {
    const { service } = await loadModules();

    await expect(service.fetchAssets()).rejects.toThrow(
      /SAP_ASSETS_DIR is set/,
    );
  });

  it("names the missing files with their sizes and digests", async () => {
    const { service } = await loadModules();
    const hint = await service.manualInstallHint(["CoreFP", "CommerceKit"]);

    expect(hint).toContain(dir);
    expect(hint).toContain(`CoreFP  ${specOf("CoreFP").size} bytes`);
    expect(hint).toContain(`sha256:${specOf("CoreFP").sha256}`);
    expect(hint).toContain("CommerceKit");
    expect(hint).not.toContain("CoreFP.icxs");
  });
});

describe("SAP asset endpoints", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "asspp-sap-"));
    process.env.SAP_ASSETS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.SAP_ASSETS_DIR;
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  it("is not ready while assets are missing, and says which", async () => {
    const { app } = await loadModules();
    const res = await request(app).get("/api/sap/assets");

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.available).toEqual([]);
    expect(res.body.missing).toHaveLength(SPECS.length);
    expect(res.body.fetching).toBe(false);
  });

  it("becomes ready once every asset verifies", async () => {
    for (const asset of STAND_INS) await writeAsset(asset.name, asset.body);

    const { app } = await loadModules();
    const res = await request(app).get("/api/sap/assets");

    expect(res.body.ready).toBe(true);
    expect(res.body.missing).toEqual([]);
    expect(res.body.available.sort()).toEqual(SPECS.map((a) => a.name).sort());
  });

  it("answers 503 with a hint for an asset that is not installed", async () => {
    const { app } = await loadModules();
    const res = await request(app).get("/api/sap/assets/CoreFP");

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("not installed");
    expect(res.body.hint).toContain("/api/sap/assets/fetch");
  });

  it("answers 500 for an asset that fails its digest", async () => {
    await writeAsset("CoreFP", "x".repeat(specOf("CoreFP").size));

    const { app } = await loadModules();
    const res = await request(app).get("/api/sap/assets/CoreFP");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("does not match its digest");
  });

  it("serves a verified asset with its exact bytes and an immutable cache header", async () => {
    await writeAsset("CommerceCore", bodies.CommerceCore);

    const { app } = await loadModules();
    // The route serves application/octet-stream, which superagent leaves
    // alone unless told to buffer it.
    const res = await request(app)
      .get("/api/sap/assets/CommerceCore")
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString("utf8")).toBe(bodies.CommerceCore);
    expect(res.headers["content-length"]).toBe(String(specOf("CommerceCore").size));
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("refuses a name that is not in the manifest", async () => {
    const { app } = await loadModules();
    const res = await request(app).get("/api/sap/assets/not-an-asset");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unknown SAP asset");
  });
});

describe("SAP asset download failure", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "asspp-sap-"));
    process.env.DATA_DIR = dir;
    delete process.env.SAP_ASSETS_DIR;
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    vi.resetModules();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("says why the CDN was unreachable and what to do instead", async () => {
    // Node collapses every fetch failure into "fetch failed" and puts the
    // actual reason on .cause. An operator on a restricted host needs both.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("fetch failed"), {
          cause: new Error("getaddrinfo ENOTFOUND swcdn.apple.com"),
        });
      }),
    );

    vi.resetModules();
    const { fetchAssets } = await import("../src/services/sapAssets.js");

    await expect(fetchAssets()).rejects.toThrow(
      /cannot reach swcdn\.apple\.com[\s\S]*ENOTFOUND[\s\S]*SAP_ASSETS_DIR/,
    );
  });
});
