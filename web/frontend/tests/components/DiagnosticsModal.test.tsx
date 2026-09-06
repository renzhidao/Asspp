import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DiagnosticsModal from "../../src/components/Settings/DiagnosticsModal";
import { apiGet } from "../../src/api/client";
import { useAccountsStore } from "../../src/store/accounts";
import { useSapStore } from "../../src/store/sap";
import type { Account } from "../../src/types";

vi.mock("../../src/api/client", () => ({ apiGet: vi.fn() }));
vi.mock("../../src/store/toast", () => ({
  useToastStore: Object.assign(vi.fn(() => ({ addToast: vi.fn() })), {
    // The component reads the store via a selector.
    ...{},
  }),
}));

const SECRET = "password-that-must-not-appear";

const account: Account = {
  email: "richard@example.com",
  password: SECRET,
  appleId: "1234567890",
  store: "143441",
  firstName: "Richard",
  lastName: "Testperson",
  passwordToken: "token-must-not-appear",
  directoryServicesIdentifier: "dsid-must-not-appear",
  cookies: [],
  deviceIdentifier: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
};

describe("DiagnosticsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAccountsStore.setState({ accounts: [account], loading: false });
    useSapStore.setState({
      stage: "assets",
      percent: 42,
      error: null,
      hardwareID: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    });
  });

  it("collects both endpoints and shows a report with no credentials in it", async () => {
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path === "/api/settings")
        return { buildCommit: "3bc9515", uptime: 99, port: 8080, dataDir: "/data" } as any;
      if (path === "/api/sap/assets")
        return {
          ready: false,
          available: [],
          missing: ["CommerceKit", "CommerceCore", "CoreFP", "CoreFP.icxs"],
          corrupt: [],
          fetching: false,
          error: "cannot reach swcdn.apple.com: TLS disconnected.\nSet SAP_ASSETS_DIR.",
        } as any;
      throw new Error(`unexpected path ${path}`);
    });

    render(<DiagnosticsModal open onClose={() => {}} />);

    const report = await waitFor(() => {
      const pre = screen.getByLabelText("settings.diagnostics.reportLabel");
      expect(pre.textContent).toContain("[sap assets]");
      return pre.textContent!;
    });

    expect(vi.mocked(apiGet)).toHaveBeenCalledWith("/api/settings");
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith("/api/sap/assets");

    expect(report).toContain("buildCommit: 3bc9515");
    expect(report).toContain("missing: CommerceKit, CommerceCore, CoreFP, CoreFP.icxs");
    expect(report).toContain("Set SAP_ASSETS_DIR.");
    expect(report).toContain("r***@example.com");

    for (const secret of [SECRET, "token-must-not-appear", "dsid-must-not-appear", "richard@example.com"]) {
      expect(report).not.toContain(secret);
    }
  });

  it("still produces a report when the server does not answer", async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error("Failed to fetch"));

    render(<DiagnosticsModal open onClose={() => {}} />);

    const report = await waitFor(() => {
      const pre = screen.getByLabelText("settings.diagnostics.reportLabel");
      expect(pre.textContent).toContain("[signer]");
      return pre.textContent!;
    });

    expect(report).toContain("unreachable: Failed to fetch");
    expect(report).toContain("stage: assets");
  });

  it("distinguishes the server downloading the binaries from the phone downloading them", async () => {
    vi.mocked(apiGet).mockImplementation(async (path: string) =>
      path === "/api/settings" ? ({ buildCommit: "3bc9515" } as any) : ({ ready: true } as any),
    );
    // The stage a first-time visitor actually sits in: the server is still
    // pulling 38 MB from Apple, so there is no honest percentage to show.
    useSapStore.setState({ stage: "installing", percent: null, error: null, hardwareID: "a1b2" } as any);

    const { default: SapStatus } = await import("../../src/components/common/SapStatus");
    const { container } = render(<SapStatus />);

    expect(container.textContent).toBe("accounts.addForm.installingAssets");
  });

  it("copies the report to the clipboard on request", async () => {
    vi.mocked(apiGet).mockImplementation(async (path: string) =>
      path === "/api/settings" ? ({ buildCommit: "3bc9515" } as any) : ({ ready: true } as any),
    );
    // Defined after setup(): userEvent installs its own clipboard stub, so
    // anything set beforehand gets replaced.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<DiagnosticsModal open onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByLabelText("settings.diagnostics.reportLabel").textContent).toContain("[sap assets]"),
    );

    await user.click(screen.getByRole("button", { name: "settings.diagnostics.copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("AssppWeb diagnostics");
    expect(copied).not.toContain(SECRET);
  });
});
