import { describe, it, expect, vi, beforeEach } from "vitest";

// "App Not Available" came back for an app that is live and free in the
// account's storefront. The words do not say which rule refused it; Apple's
// numeric failureType does, and it was discarded whenever a message was present.

const appleRequest = vi.hoisted(() => vi.fn());

vi.mock("../../src/apple/request", () => ({ appleRequest }));
vi.mock("../../src/i18n", () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  },
}));

const { purchaseApp, PurchaseError } = await import("../../src/apple/purchase");

const account = {
  email: "a@example.com",
  passwordToken: "t",
  directoryServicesIdentifier: "d",
  store: "143465",
  cookies: [],
  deviceIdentifier: "g",
} as never;

const app = { id: "1468454200", name: "番茄小说", price: 0 } as never;

/** A real plist, in the shape Apple actually answers with. */
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

describe("purchase failures", () => {
  beforeEach(() => appleRequest.mockReset());

  it("keeps Apple's numeric code next to its words", async () => {
    respond({
      failureType: "9008",
      customerMessage: "App Not Available",
    });

    const error = await purchaseApp(account, app).catch((e) => e);
    expect(error).toBeInstanceOf(PurchaseError);
    // The code is what distinguishes one refusal from another.
    expect(error.message).toContain("9008");
    expect(error.code).toBe("9008");
  });
});
