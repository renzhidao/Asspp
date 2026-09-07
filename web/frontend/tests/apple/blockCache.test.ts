import { describe, it, expect } from "vitest";
import { BlockCache } from "../../src/apple/sap/machine";
import type { Block } from "../../src/apple/sap/length";

// The error that found the cost read 1,003,147 blocks against a budget that
// had barely moved: a million turns of the loop for fifteen million
// instructions, each paying a fresh 480-byte read and decode. Guest code loops,
// so the cache exists to stop measuring the same block over and over.

const block = { instructions: 9, end: 24 } as unknown as Block;

describe("BlockCache", () => {
  it("returns undefined for an address it has never seen", () => {
    const cache = new BlockCache();
    expect(cache.get(0x1000n)).toBeUndefined();
  });

  it("gives back what was measured at an address", () => {
    const cache = new BlockCache();
    cache.set(0x1000n, block);
    expect(cache.get(0x1000n)).toBe(block);
  });

  it("distinguishes a measured null from a miss", () => {
    // A block the decoder could not read is cached as null, and has to come
    // back as null — not as undefined, which would mean "decode it again".
    const cache = new BlockCache();
    cache.set(0x2000n, null);
    expect(cache.get(0x2000n)).toBeNull();
    expect(cache.get(0x2000n)).not.toBeUndefined();
  });

  it("keeps distinct addresses apart", () => {
    const cache = new BlockCache();
    cache.set(0x1000n, block);
    expect(cache.get(0x1001n)).toBeUndefined();
  });

  it("empties rather than grows without bound", () => {
    const cache = new BlockCache(4);
    for (let index = 0; index < 4; index++) cache.set(BigInt(0x1000 + index), block);
    expect(cache.size).toBe(4);

    cache.set(0x9999n, block);
    // A wrong hint would be worse than a miss, so a full cache is dropped
    // whole instead of evicting entries one at a time.
    expect(cache.size).toBe(1);
    expect(cache.get(0x1000n)).toBeUndefined();
  });

  it("clears, so a new run starts from nothing", () => {
    const cache = new BlockCache();
    cache.set(0x1000n, block);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get(0x1000n)).toBeUndefined();
  });
});
