import { describe, it, expect, vi, beforeEach } from "vitest";

// The third volumeStore caller. ipatool sends serialNumber on all three; the
// check is per app, not per caller, so missing it anywhere reproduces the same
// "App Not Available" with an empty failureType.

const appleRequest = vi.hoisted(() => vi.fn());

vi.mock("../../src/apple/request", () => ({ appleRequest }));

const mod = await import("../../src/apple/versionLookup");
const fn = Object.values(mod).find((v) => typeof v === "function") as (
  ...args: unknown[]
) => Promise<unknown>;

const account = {
  email: "a@example.com",
  directoryServicesIdentifier: "d",
  store: "143465",
  cookies: [],
  deviceIdentifier: "8a85f3e21c9d",
} as never;

const app = { id: "1468454200", name: "番茄小说" } as never;

describe("the version metadata payload", () => {
  beforeEach(() => appleRequest.mockReset());

  it("carries serialNumber", async () => {
    appleRequest.mockResolvedValue({
      status: 200,
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n  <dict>\n    <key>failureType</key>\n    <string></string>\n  </dict>\n</plist>`,
      headers: {},
      rawHeaders: [],
    });

    await fn(account, app, "123").catch(() => {});

    expect(appleRequest).toHaveBeenCalled();
    expect(appleRequest.mock.calls[0][0].body).toContain(
      "<key>serialNumber</key>",
    );
  });
});
