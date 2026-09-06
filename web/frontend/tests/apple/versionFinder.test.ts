import { describe, it, expect, vi, beforeEach } from "vitest";

// "Could not load version history" was the whole of what a user got. The
// response had a failureType that said which rule refused, and it was dropped.

const appleRequest = vi.hoisted(() => vi.fn());

vi.mock("../../src/apple/request", () => ({ appleRequest }));

const { listVersions } = await import("../../src/apple/versionFinder");

const account = {
  email: "a@example.com",
  directoryServicesIdentifier: "d",
  store: "143465",
  cookies: [],
  deviceIdentifier: "8a85f3e21c9d",
} as never;

const app = { id: "1468454200", name: "番茄小说" } as never;

function respond(fields: Record<string, string>) {
  const body = Object.entries(fields)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
    .join("\n");
  appleRequest.mockResolvedValue({
    status: 200,
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n  <dict>\n${body}\n  </dict>\n</plist>`,
    headers: {},
    rawHeaders: [],
  });
}

describe("version history refusals", () => {
  beforeEach(() => appleRequest.mockReset());

  it("says which rule refused", async () => {
    respond({ failureType: "9008", customerMessage: "App Not Available" });

    await expect(listVersions(account, app)).rejects.toThrow(
      /App Not Available \(9008\)/,
    );
  });

  it("names the missing licence instead of a generic nothing", async () => {
    respond({ failureType: "9610" });

    await expect(listVersions(account, app)).rejects.toThrow(/9610/);
  });

  it("still carries the code when Apple sends no words", async () => {
    respond({ failureType: "9008" });

    await expect(listVersions(account, app)).rejects.toThrow(
      /No items in response \(9008\)/,
    );
  });
});

describe("an empty failureType", () => {
  beforeEach(() => appleRequest.mockReset());

  it("is reported as empty", async () => {
    respond({ failureType: "", customerMessage: "App Not Available" });

    await expect(listVersions(account, app)).rejects.toThrow(
      /App Not Available \(code=empty\)/,
    );
  });

  it("distinguishes absent from empty", async () => {
    respond({ customerMessage: "App Not Available" });

    await expect(listVersions(account, app)).rejects.toThrow(/code=absent/);
  });
});

describe("the volumeStore payload", () => {
  beforeEach(() => appleRequest.mockReset());

  it("carries serialNumber", async () => {
    respond({ failureType: "", customerMessage: "App Not Available" });

    await listVersions(account, app).catch(() => {});

    expect(appleRequest.mock.calls[0][0].body).toContain(
      "<key>serialNumber</key>",
    );
  });
});
