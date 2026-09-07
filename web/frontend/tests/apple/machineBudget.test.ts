import { describe, it, expect } from "vitest";
import { unassistedAllowance } from "../../src/apple/sap/machine";

// A diagnostic report arrived with exchange.1 running for 654 seconds on a
// phone whose measured guest speed is about twenty thousand instructions a
// second. The cause was a block the decoder could not read handing the whole
// 100M budget to one emu_start — roughly eighty minutes inside a single call,
// against a 15 minute client timeout, and silent throughout because nothing
// can report from inside a running emulator.

const LIMIT = 2_000_000;

describe("unassistedAllowance", () => {
  it("lets a first undecodable block run, bounded by the cap rather than the budget", () => {
    // The budget starts at 100M. Without the cap that whole figure went to one
    // emu_start.
    expect(unassistedAllowance(100_000_000, 0)).toEqual({
      allowed: LIMIT,
      exhausted: false,
    });
  });

  it("never grants more than the caller's remaining budget", () => {
    expect(unassistedAllowance(500, 0)).toEqual({ allowed: 500, exhausted: false });
  });

  it("refuses once the cap is used up, so the guest fails instead of hanging", () => {
    expect(unassistedAllowance(100_000_000, LIMIT)).toEqual({
      allowed: 0,
      exhausted: true,
    });
    expect(unassistedAllowance(100_000_000, LIMIT + 1)).toEqual({
      allowed: 0,
      exhausted: true,
    });
  });

  it("grants only what is left of the cap across repeated blocks", () => {
    expect(unassistedAllowance(100_000_000, LIMIT - 1000)).toEqual({
      allowed: 1000,
      exhausted: false,
    });
  });
});
