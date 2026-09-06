import { describe, it, expect } from "vitest";
import {
  deadlineExceeded,
  describeGuestRun,
} from "../../src/apple/sap/machine";

// A report came back with exchange.1 running for 332 seconds. The 2M cap on
// unassisted instructions had not fired, which rules that path out — at the
// measured 73k instructions a second on that device the cap is 27 seconds of
// work. The time was going somewhere the report could not see, so the guest
// call now has a wall-clock deadline and reports where it was when it hit it.

const T0 = Date.parse("2026-09-06T13:00:00.000Z");

describe("deadlineExceeded", () => {
  it("lets a call that a desktop would finish run", () => {
    // A desktop completes the whole setup in 115s, so one call is well inside.
    expect(deadlineExceeded(T0, T0 + 120_000)).toBe(false);
  });

  it("fires past three minutes", () => {
    expect(deadlineExceeded(T0, T0 + 180_001)).toBe(true);
  });

  it("accepts an explicit limit", () => {
    expect(deadlineExceeded(T0, T0 + 5_000, 1_000)).toBe(true);
    expect(deadlineExceeded(T0, T0 + 500, 1_000)).toBe(false);
  });
});

describe("describeGuestRun", () => {
  it("carries the four numbers that tell the two failure modes apart", () => {
    const text = describeGuestRun({
      elapsedMs: 181_400,
      steps: 4_200_000,
      measureFailures: 3,
      unassisted: 60_000,
      budget: 99_940_000,
    });

    expect(text).toContain("elapsed 181.4s");
    // Many blocks against a barely-moved budget says the guest is looping, or
    // that per-block overhead dominates — not that it needs more instructions.
    expect(text).toContain("4200000 blocks");
    expect(text).toContain("3 undecodable");
    expect(text).toContain("60000 unassisted instructions");
    expect(text).toContain("budget left 99940000");
  });
});
