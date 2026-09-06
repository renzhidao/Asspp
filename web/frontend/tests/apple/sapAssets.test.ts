import { describe, expect, it, vi, afterEach } from "vitest";
import { loadAssets } from "../../src/apple/sap/assets";

// The regression this pins down was visible in a real diagnostic report as
// `stage: assets, percent: 100` while 29 MB of the 38 MB had not been
// downloaded. The four binaries download in parallel and differ in size by two
// orders of magnitude, so reporting whichever file spoke last read as 100% the
// moment the 207 KB one landed.

const SIZES: Record<string, number> = {
  CommerceKit: 100,
  CommerceCore: 20, // lands almost immediately, the way the real 207 KB one does
  CoreFP: 1000, // the big one, still in flight
  "CoreFP.icxs": 300,
};

const TOTAL = Object.values(SIZES).reduce((a, b) => a + b, 0);

function streamOf(bytes: Uint8Array, chunkSize: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/**
 * Stubs fetch so that every asset is "ready" on the server, HEAD answers with
 * the size, and GET streams — except that CoreFP never finishes, which is the
 * state a real deployment sits in for most of the download.
 */
function stubFetch(opts: { stallCoreFP?: boolean } = {}) {
  const requests: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);

      if (url === "/api/sap/assets") {
        return new Response(
          JSON.stringify({
            ready: true,
            fetching: false,
            available: Object.keys(SIZES),
            missing: [],
            corrupt: [],
            progress: null,
            error: null,
          }),
          { status: 200 },
        );
      }

      const name = url.replace("/api/sap/assets/", "");
      const size = SIZES[name];
      if (size === undefined) return new Response("nope", { status: 404 });

      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Content-Length": String(size) },
        });
      }

      if (opts.stallCoreFP && name === "CoreFP") {
        // Emits one chunk then never resolves, so the promise stays pending
        // exactly as an in-flight 29 MB download does.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(50));
            },
          }),
          { status: 200, headers: { "Content-Length": String(size) } },
        );
      }

      return new Response(streamOf(new Uint8Array(size).fill(7), 10), {
        status: 200,
        headers: { "Content-Length": String(size) },
      });
    }),
  );

  return requests;
}

/** Runs loadAssets but gives up once the stall means it cannot finish. */
function loadUntilStalled(onProgress: (p: { loaded: number; total: number }) => void) {
  const pending = loadAssets({}, onProgress);
  // Swallow the rejection: the stalled stream leaves this unresolved forever,
  // and an unhandled rejection would fail the run for the wrong reason.
  pending.catch(() => {});
  return pending;
}

describe("SAP asset progress", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not report 100% while most of the bytes are still missing", async () => {
    stubFetch({ stallCoreFP: true });

    const seen: number[] = [];
    loadUntilStalled((p) => {
      if (p.total > 0) seen.push(Math.round((p.loaded / p.total) * 100));
    });

    // Let the three small downloads finish and their progress arrive.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen.length).toBeGreaterThan(0);

    // The three that finished are 100 + 20 + 300 of 1420 bytes, plus the 50
    // CoreFP had emitted: about 33%. The old code's last message here came
    // from CommerceCore completing, and said 100%.
    expect(Math.max(...seen)).toBeLessThan(50);
    expect(seen).not.toContain(100);
  });

  it("reaches 100% only when everything is actually in hand", async () => {
    stubFetch();

    const seen: { loaded: number; total: number }[] = [];
    await loadAssets({}, (p) => seen.push({ loaded: p.loaded, total: p.total }));

    const last = seen[seen.length - 1];
    expect(last.total).toBe(TOTAL);
    expect(last.loaded).toBe(TOTAL);
  });

  it("reports every byte it is given, not just the last file's", async () => {
    stubFetch();

    const seen: number[] = [];
    await loadAssets({}, (p) => seen.push(p.loaded));

    // Monotonic: progress is accumulated across files, so it can never go
    // backwards the way per-file reporting did when a small file finished
    // after a large one had made headway.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it("sizes the assets up front so the total is real", async () => {
    const requests = stubFetch();

    await loadAssets({}, () => {});

    const heads = requests.filter((r) => r.startsWith("HEAD "));
    expect(heads).toHaveLength(Object.keys(SIZES).length);
  });

  it("still downloads when HEAD is refused, without inventing a total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/sap/assets") {
          return new Response(
            JSON.stringify({ ready: true, missing: [], corrupt: [], error: null }),
            { status: 200 },
          );
        }
        if (init?.method === "HEAD") return new Response(null, { status: 405 });

        const name = url.replace("/api/sap/assets/", "");
        const size = SIZES[name];
        return new Response(new Uint8Array(size).fill(7), {
          status: 200,
          headers: { "Content-Length": String(size) },
        });
      }),
    );

    const seen: { loaded: number; total: number }[] = [];
    await loadAssets({}, (p) => seen.push({ loaded: p.loaded, total: p.total }));

    // No cross-file total is known, so it falls back to per-file numbers
    // rather than a percentage computed against a wrong denominator.
    expect(seen.every((p) => p.total > 0)).toBe(true);
    expect(seen.every((p) => p.total <= Math.max(...Object.values(SIZES)))).toBe(
      true,
    );
  });
});
