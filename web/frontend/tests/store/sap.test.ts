import { describe, it, expect, beforeEach } from "vitest";
import { useSapStore } from "../../src/store/sap";

// A real report arrived with every step listed twice — once as STILL RUNNING
// and once with a duration — and stuckInStep naming a step that had already
// finished. Both came from keeping the begin entry around after the end
// arrived.

const T0 = Date.parse("2026-09-06T12:20:00.000Z");

describe("recording setup steps", () => {
  beforeEach(() => {
    useSapStore.setState({ events: [], stage: "idle", percent: null, setupStartedAt: null, lastError: null, error: null, hardwareID: null });
  });

  it("folds a step's end into its begin instead of appending a second entry", () => {
    const { recordEvent } = useSapStore.getState();

    recordEvent({ label: "machine.open", at: T0 });
    recordEvent({ label: "machine.open", at: T0, endedAt: T0 + 1300 });

    expect(useSapStore.getState().events).toEqual([
      { label: "machine.open", at: T0, endedAt: T0 + 1300 },
    ]);
  });

  it("keeps steps in order and leaves the running one open", () => {
    const { recordEvent } = useSapStore.getState();

    recordEvent({ label: "machine.open", at: T0 });
    recordEvent({ label: "machine.open", at: T0, endedAt: T0 + 1300 });
    recordEvent({ label: "machine.initialize", at: T0 + 1300 });
    recordEvent({ label: "machine.initialize", at: T0 + 1300, endedAt: T0 + 74_200 });
    recordEvent({ label: "exchange.1", at: T0 + 74_600 });

    const { events } = useSapStore.getState();
    expect(events.map((event) => event.label)).toEqual([
      "machine.open",
      "machine.initialize",
      "exchange.1",
    ]);
    // The one genuinely in progress has no end.
    expect(events[2].endedAt).toBeUndefined();
  });

  it("treats a second attempt as a new step rather than folding into the first", () => {
    const { recordEvent } = useSapStore.getState();

    recordEvent({ label: "machine.open", at: T0 });
    recordEvent({ label: "machine.open", at: T0, endedAt: T0 + 1300 });
    // A rebuilt signer starts over; its machine.open must not overwrite the
    // recorded cost of the first one.
    recordEvent({ label: "machine.open", at: T0 + 60_000 });

    const { events } = useSapStore.getState();
    expect(events).toHaveLength(2);
    expect(events[0].endedAt).toBe(T0 + 1300);
    expect(events[1].at).toBe(T0 + 60_000);
    expect(events[1].endedAt).toBeUndefined();
  });
});

// A report arrived reading `setupSeconds: 13` alongside a timeline whose first
// entry was at +118.8s. begin() reset setupStartedAt but kept the events, so a
// retry measured its timeline from the previous attempt.
describe("starting a new attempt", () => {
  beforeEach(() => {
    useSapStore.setState({ events: [], stage: "idle", percent: null, setupStartedAt: null, lastError: null, error: null, hardwareID: null });
  });

  it("drops the previous attempt's steps", () => {
    const store = useSapStore.getState();
    store.recordEvent({ label: "machine.open", at: T0 });
    store.setSetup();

    useSapStore.getState().begin("ffff");

    const after = useSapStore.getState();
    expect(after.events).toEqual([]);
    // A fresh timeline has to start from the new attempt, or the report mixes
    // two of them and every offset in it is wrong.
    expect(after.setupStartedAt).toBeNull();
  });

  it("keeps the reason the previous attempt failed", () => {
    useSapStore.getState().setError("SAP guest call exceeded 180s");

    useSapStore.getState().begin("ffff");

    const after = useSapStore.getState();
    // Retrying is how the evidence used to get erased.
    expect(after.error).toBeNull();
    expect(after.lastError).toBe("SAP guest call exceeded 180s");
  });

  it("keeps the most recent failure across several retries", () => {
    useSapStore.getState().setError("first");
    useSapStore.getState().begin("aaaa");
    useSapStore.getState().setError("second");
    useSapStore.getState().begin("bbbb");

    expect(useSapStore.getState().lastError).toBe("second");
  });
});
