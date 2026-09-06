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

// Apple only enforces the check on some apps, which is exactly the pattern in
// the field: every ByteDance app failed, an ordinary one worked. Without the
// key the endpoint answers "App Not Available" and an empty failureType, so
// nothing in the response said what was missing.
describe("the volumeStore payload", () => {
  beforeEach(() => appleRequest.mockReset());

  it("carries serialNumber", async () => {
    respond({ failureType: "", customerMessage: "App Not Available" });

    await getDownloadInfo(account, app).catch(() => {});

    const sent = appleRequest.mock.calls[0][0];
    expect(sent.body).toContain("<key>serialNumber</key>");
    expect(sent.body).toContain("<string>0</string>");
  });
});

// Four hypotheses have been wrong. This asserts the report carries the whole
// exchange, which is what settles the next one without another guess.
describe("the failure report", () => {
  beforeEach(() => appleRequest.mockReset());

  it("carries the endpoint, the status, what was sent and what came back", async () => {
    respond({ failureType: "", customerMessage: "App Not Available" });

    const error = await getDownloadInfo(account, app).catch((e) => e);

    expect(error.message).toContain("endpoint=");
    expect(error.message).toContain("volumeStoreDownloadProduct");
    expect(error.message).toContain("http=200");
    // Proof of what actually went out — the one thing that has been assumed
    // rather than shown this whole time.
    expect(error.message).toContain("sent=");
    expect(error.message).toContain("serialNumber");
    expect(error.message).toContain("resp=");
    expect(error.message).toContain("App Not Available");
  });
});
