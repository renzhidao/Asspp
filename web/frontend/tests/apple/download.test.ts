import { describe, it, expect, vi, beforeEach } from "vitest";

// The report said "App Not Available" with no code. This is the branch that
// threw it: the volumeStore endpoint answers with a failureType and a
// customerMessage, and the customerMessage branch returns before the
// empty-songList check that the code had been attached to.

const appleRequest = vi.hoisted(() => vi.fn());

vi.mock("../../src/apple/request", () => ({ appleRequest }));
vi.mock("../../src/i18n", () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  },
}));

const { getDownloadInfo, DownloadError } = await import("../../src/apple/download");

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

describe("the volumeStore refusal", () => {
  beforeEach(() => appleRequest.mockReset());

  it("carries Apple's code, not just its words", async () => {
    respond({
      failureType: "9008",
      customerMessage: "App Not Available",
    });

    const error = await getDownloadInfo(account, app).catch((e) => e);

    expect(error).toBeInstanceOf(DownloadError);
    expect(error.message).toContain("App Not Available");
    // Without the code every refusal reads the same, and the apps that fail
    // here are live and free in this storefront, so the words identify nothing.
    expect(error.message).toContain("9008");
    expect(error.code).toBe("9008");
  });

  it("still localises when Apple sends no words", async () => {
    respond({ failureType: "9008" });

    const error = await getDownloadInfo(account, app).catch((e) => e);

    expect(error.message).toContain("errors.download.downloadFailed");
    expect(error.code).toBe("9008");
  });
});

// The response that actually arrives from the field: failureType present but
// empty, customerMessage present. An empty string is falsy, so every
// `if (dict.failureType)` check steps over it and the code never gets printed.
describe("an empty failureType", () => {
  beforeEach(() => appleRequest.mockReset());

  it("is reported as empty, not silently omitted", async () => {
    respond({
      failureType: "",
      customerMessage: "App Not Available",
    });

    const error = await getDownloadInfo(account, app).catch((e) => e);

    expect(error).toBeInstanceOf(DownloadError);
    expect(error.message).toContain("App Not Available");
    expect(error.message).toContain("code=empty");
    // The keys still list it, which is what made the old output look as though
    // a code had been withheld rather than never sent.
    expect(error.message).toContain("failureType");
  });
});
