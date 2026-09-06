import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jsdom has no Worker, and client.ts constructs one at module scope of
// prepareSigner, so the whole thing is replaced. Every instance is recorded so
// a test can tell which one was terminated.
const workers = vi.hoisted(() => [] as unknown[]);

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown) {
    if (this.terminated) throw new Error("posted to a terminated worker");
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }
}

vi.stubGlobal("Worker", FakeWorker);

vi.mock("../../src/components/Auth/PasswordGate", () => ({ getAccessToken: () => null }));

const { prepareSigner } = await import("../../src/apple/sap/client");
const { useSapStore } = await import("../../src/store/sap");

// A signer's setup never resolves on its own here; a test settles it by hand.
const settle = (worker: FakeWorker, type: "ready" | "error", message = "boom") =>
  worker.onmessage?.({
    data: type === "ready" ? { type: "ready" } : { type: "error", message },
  } as MessageEvent);

describe("prepareSigner rebuilding for a different hardware id", () => {
  beforeEach(() => {
    FakeWorker.instances.length = 0;
    useSapStore.setState({ stage: "idle", percent: null, error: null, hardwareID: null });
  });

  afterEach(() => {
    for (const worker of FakeWorker.instances) if (!worker.terminated) worker.terminate();
  });

  it("kills the old worker and keeps the new one alive to finish the setup", async () => {
    const first = prepareSigner("aaaaaaaaaaaa");
    settle(FakeWorker.instances[0] as FakeWorker, "ready");
    await first;

    // Only now is there something to rebuild: `ready` is set, so a different
    // hardware id takes the rebuild path and reset() runs.
    const second = prepareSigner("bbbbbbbbbbbb");

    const [oldWorker, newWorker] = FakeWorker.instances as FakeWorker[];
    expect(FakeWorker.instances).toHaveLength(2);
    expect(oldWorker.terminated).toBe(true);
    // The bug: `worker` was already pointing at the new instance by the time
    // reset() terminated it, so the one about to be used was killed before its
    // setup request went out.
    expect(newWorker.terminated).toBe(false);
    expect(newWorker.posted).toEqual([
      expect.objectContaining({ type: "setup", hardwareID: expect.any(Uint8Array) }),
    ]);

    settle(newWorker, "ready");
    await expect(second).resolves.toBeUndefined();
    expect(useSapStore.getState().stage).toBe("ready");
  });

  it("reports the abandoned attempt rather than leaving it waiting", async () => {
    const first = prepareSigner("cccccccccccc");
    prepareSigner("dddddddddddd");

    await expect(first).rejects.toThrow(/different device/);
  });
});
