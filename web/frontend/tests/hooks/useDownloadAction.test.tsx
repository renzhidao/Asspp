import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Clicking download before a licence existed used to fail with Apple's 9610,
// and the only way past it was a second button that re-signed everything.
// Acquiring a licence needs no signature at all.

const getDownloadInfo = vi.hoisted(() => vi.fn());
const purchaseApp = vi.hoisted(() => vi.fn());
const authenticate = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const apiGet = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ maxDownloadMB: 0 })),
);

// The real classes, so the instanceof checks in the hook see the same ones the
// test throws. The modules themselves are replaced wholesale: importing the
// originals would pull in libcurl.js, which aborts outside a browser.
const { DownloadError, PurchaseError } = vi.hoisted(() => {
  class WithCode extends Error {
    constructor(message: string, public readonly code?: string) {
      super(message);
    }
  }
  return { DownloadError: WithCode, PurchaseError: WithCode };
});

vi.mock("../../src/apple/download", () => ({ getDownloadInfo, DownloadError }));
vi.mock("../../src/apple/purchase", () => ({ purchaseApp, PurchaseError }));
vi.mock("../../src/apple/authenticate", () => ({ authenticate }));
vi.mock("../../src/api/client", () => ({ apiPost, apiGet }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh-CN" },
    t: (key: string) => key,
  }),
}));

const { useDownloadAction } = await import("../../src/hooks/useDownloadAction");
const { useActivityStore } = await import("../../src/store/activity");

const account = {
  email: "richard@example.com",
  password: "secret",
  passwordToken: "token",
  directoryServicesIdentifier: "dsid",
  store: "143465",
  cookies: [],
  deviceIdentifier: "a1b2c3d4e5f6",
} as never;

const app = { id: "364716699", name: "Candy Crush Saga" } as never;

const ok = {
  output: {
    bundleShortVersionString: "1.0",
    downloadURL: "https://example.com/app.ipa",
    sinfs: {},
    iTunesMetadata: "",
  },
  updatedCookies: [],
};

describe("downloading an app the account has no licence for", () => {
  beforeEach(() => {
    getDownloadInfo.mockReset();
    purchaseApp.mockReset();
    authenticate.mockReset();
    apiPost.mockClear();
    useActivityStore.setState({ entries: [] });
  });

  it("acquires the licence and carries on", async () => {
    getDownloadInfo
      .mockRejectedValueOnce(new DownloadError("需要许可证", "9610"))
      .mockResolvedValueOnce(ok);
    purchaseApp.mockResolvedValue({ updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    await result.current.startDownload(account, app);

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(purchaseApp).toHaveBeenCalledTimes(1);
    expect(getDownloadInfo).toHaveBeenCalledTimes(2);
  });

  it("does not sign anything to get there", async () => {
    getDownloadInfo
      .mockRejectedValueOnce(new DownloadError("需要许可证", "9610"))
      .mockResolvedValueOnce(ok);
    purchaseApp.mockResolvedValue({ updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    await result.current.startDownload(account, app);

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    // A signature costs a whole SAP setup. This path must never need one.
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("leaves any other failure alone", async () => {
    getDownloadInfo.mockRejectedValue(new DownloadError("密码已过期", "2034"));

    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.startDownload(account, app)).rejects.toThrow();

    expect(purchaseApp).not.toHaveBeenCalled();
    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
  });
});

describe("acquiring a licence", () => {
  beforeEach(() => {
    getDownloadInfo.mockReset();
    purchaseApp.mockReset();
    authenticate.mockReset();
  });

  it("uses the token it already has instead of signing in again", async () => {
    purchaseApp.mockResolvedValue({ updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    await result.current.acquireLicense(account, app);

    expect(purchaseApp).toHaveBeenCalledTimes(1);
    // This is the click that used to cost several minutes: authenticate()
    // begins with prepareSigner(), and the signer does not survive a reload.
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("signs in again only once Apple says the token expired", async () => {
    purchaseApp
      .mockRejectedValueOnce(new PurchaseError("密码已过期", "2034"))
      .mockResolvedValue({ updatedCookies: [] });
    authenticate.mockResolvedValue(account);

    const { result } = renderHook(() => useDownloadAction());
    await result.current.acquireLicense(account, app);

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(purchaseApp).toHaveBeenCalledTimes(2);
  });

  it("rethrows anything that is not an expired token", async () => {
    purchaseApp.mockRejectedValue(new PurchaseError("不可用", "2059"));

    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.acquireLicense(account, app)).rejects.toThrow();

    expect(authenticate).not.toHaveBeenCalled();
  });
});

// The report used to say nothing about a failed download, so there was nothing
// to diagnose it from.
describe("recording what was tried", () => {
  beforeEach(() => {
    getDownloadInfo.mockReset();
    purchaseApp.mockReset();
    authenticate.mockReset();
    apiPost.mockClear();
    useActivityStore.setState({ entries: [] });
  });

  it("records a download that failed and why", async () => {
    getDownloadInfo.mockRejectedValue(new DownloadError("响应中没有项目 (store=143465 keys=dialog)", "x"));

    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.startDownload(account, app)).rejects.toThrow();

    const entries = useActivityStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("download");
    expect(entries[0].target).toBe("Candy Crush Saga");
    expect(entries[0].ok).toBe(false);
    expect(entries[0].detail).toContain("响应中没有项目");
  });

  it("records a licence that worked", async () => {
    purchaseApp.mockResolvedValue({ updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    await result.current.acquireLicense(account, app);

    const entries = useActivityStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("license");
    expect(entries[0].ok).toBe(true);
  });
});
