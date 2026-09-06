import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { authenticate } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { prepareSigner, signAction } from "../../src/apple/sap/client";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

// The real client spins up a Web Worker that emulates Apple's signing code.
// jsdom has no Worker, and none of that is what these tests are about.
vi.mock("../../src/apple/sap/client", () => ({
  prepareSigner: vi.fn().mockResolvedValue(undefined),
  signAction: vi.fn(),
}));

function mockSuccessfulAuth() {
  vi.mocked(appleRequest).mockResolvedValue({
    status: 200,
    statusText: "OK",
    headers: {},
    rawHeaders: [],
    body: buildPlist({
      accountInfo: {
        appleId: "test@example.com",
        address: {
          firstName: "Test",
          lastName: "User",
        },
      },
      passwordToken: "token",
      dsPersonId: "123",
    }),
  });
}

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareSigner).mockResolvedValue(undefined);
    vi.mocked(signAction).mockResolvedValue(new Uint8Array([0xde, 0xad]));
    mockSuccessfulAuth();
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("aabbccddeeff");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });

  it("prepares a signer for the device before contacting Apple", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    expect(prepareSigner).toHaveBeenCalledWith("aabbccddeeff", undefined);
    expect(vi.mocked(prepareSigner).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(appleRequest).mock.invocationCallOrder[0],
    );
  });

  it("sends the SAP signature base64-encoded in X-Apple-ActionSignature", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    // The signature covers the request body, so it has to be produced from
    // exactly the bytes that go out.
    const signed = vi.mocked(signAction).mock.calls[0][0];
    expect(new TextDecoder().decode(signed)).toContain(
      "<key>appleId</key><string>test@example.com</string>",
    );

    const headers = vi.mocked(appleRequest).mock.calls[0][0].headers;
    expect(headers?.["X-Apple-ActionSignature"]).toBe(
      btoa(String.fromCharCode(0xde, 0xad)),
    );
  });

  it("propagates a signer failure instead of sending an unsigned request", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(prepareSigner).mockRejectedValue(
      new Error("timed out preparing the SAP signer"),
    );

    await expect(
      authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      ),
    ).rejects.toThrow("timed out preparing the SAP signer");

    // An unsigned request is the one Apple answers with 403 and an empty
    // body, so it must never go out.
    expect(appleRequest).not.toHaveBeenCalled();
  });
});
