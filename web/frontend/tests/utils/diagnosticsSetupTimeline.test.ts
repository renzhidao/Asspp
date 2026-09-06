import { describe, it, expect } from "vitest";
import {
  buildDiagnostics,
  runningStep,
  type SapEvent,
} from "../../src/utils/diagnostics";

// The report exists so that one paste explains a failure. Setup is the part
// that can take minutes and says nothing while it does, so these pin down that
// the report names the step it stopped in rather than only the stage.

const T0 = Date.parse("2026-09-06T11:44:00.000Z");

function input(events: SapEvent[], setupSeconds: number | null) {
  return {
    signer: {
      stage: "setup" as const,
      percent: null,
      setupSeconds,
      events,
      error: null,
      hardwareID: "a1b2…",
    },
    accounts: [],
    language: "zh-CN",
  };
}

describe("runningStep", () => {
  it("names the step that has not ended", () => {
    const events: SapEvent[] = [
      { label: "machine.open", at: T0, endedAt: T0 + 900 },
      { label: "machine.initialize", at: T0 + 900 },
    ];
    expect(runningStep(events)?.label).toBe("machine.initialize");
  });

  it("is null once every step has ended", () => {
    const events: SapEvent[] = [
      { label: "machine.open", at: T0, endedAt: T0 + 900 },
      { label: "exchange.2", at: T0 + 900, endedAt: T0 + 1800 },
    ];
    expect(runningStep(events)).toBeNull();
  });

  it("ignores an earlier step that ended after a later one began", () => {
    // Steps are strictly sequential here, but a retried setup appends a second
    // machine.open, and the running one is the last that has not ended.
    const events: SapEvent[] = [
      { label: "machine.open", at: T0, endedAt: T0 + 900 },
      { label: "machine.initialize", at: T0 + 900, endedAt: T0 + 5000 },
      { label: "machine.open", at: T0 + 60_000 },
    ];
    expect(runningStep(events)?.at).toBe(T0 + 60_000);
  });
});

describe("the report", () => {
  it("names the step a hung setup stopped in", () => {
    const report = buildDiagnostics(
      input(
        [
          { label: "machine.open", at: T0, endedAt: T0 + 850 },
          { label: "machine.initialize", at: T0 + 850 },
        ],
        512,
      ),
    );

    expect(report).toContain("stuckInStep: machine.initialize for");
    // 850 ms, which toFixed(1) rounds down.
    expect(report).toContain("machine.open  +0.0s  took 0.8s");
    expect(report).toContain("machine.initialize  +0.8s  STILL RUNNING");
    expect(report).not.toContain("certificate.fetch");
  });

  it("shows a completed setup end to end, with what each step cost", () => {
    const report = buildDiagnostics(
      input(
        [
          { label: "machine.open", at: T0, endedAt: T0 + 900 },
          { label: "machine.initialize", at: T0 + 900, endedAt: T0 + 62_000 },
          { label: "certificate.fetch", at: T0 + 62_000, endedAt: T0 + 63_200 },
          { label: "exchange.1", at: T0 + 63_200, endedAt: T0 + 90_000 },
          { label: "setup.post", at: T0 + 90_000, endedAt: T0 + 91_500 },
          { label: "exchange.2", at: T0 + 91_500, endedAt: T0 + 118_000 },
        ],
        118,
      ),
    );

    expect(report).not.toContain("stuckInStep");
    expect(report).not.toContain("STILL RUNNING");
    expect(report).toContain("machine.initialize  +0.9s  took 61.1s");
    // The two network round trips, which are the part that can be a
    // deployment problem rather than a slow phone.
    expect(report).toContain("certificate.fetch  +62.0s  took 1.2s");
    expect(report).toContain("setup.post  +90.0s  took 1.5s");
    expect(report).toContain("exchange.2  +91.5s  took 26.5s");
  });

  it("says so when there is nothing recorded yet", () => {
    const report = buildDiagnostics(input([], null));
    expect(report).toContain("setupTimeline:");
    expect(report).toContain("none recorded");
  });
});
