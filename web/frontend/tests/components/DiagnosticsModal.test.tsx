import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DiagnosticsModal from "../../src/components/Settings/DiagnosticsModal";
import SapStatus from "../../src/components/common/SapStatus";
import { apiGet } from "../../src/api/client";
import { useAccountsStore } from "../../src/store/accounts";
import { useSapStore } from "../../src/store/sap";
import type { Account } from "../../src/types";

vi.mock("../../src/api/client", () => ({ apiGet: vi.fn() }));

// The repo's usual mock is `t: (key) => key`, which drops interpolation
// options. SapStatus passes the elapsed seconds as one, and a timer whose
// number never reaches the screen is the exact thing being tested, so this
// mock renders the options alongside the key and the assertions read them back.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // DiagnosticsModal reads i18n.language for the report's [browser] section.
    i18n: { language: "en-US" },
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
// The component reads this store through a selector —
// useToastStore((state) => state.addToast) — so the mock has to call the
// selector with a state, not hand back the state itself. Returning the state
// directly makes addToast a non-function, and the failure only surfaces in the
// copy's catch branch, as an unhandled rejection that outlives the test.
const addToast = vi.fn();
vi.mock("../../src/store/toast", () => ({
  useToastStore: (selector: (state: any) => any) =>
    selector({ addToast: (...args: unknown[]) => addToast(...args) }),
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
    // No percentage is invented for a fetch whose size the browser never
    // sees, and no seconds are counted for one the browser is not waiting on.
    expect(container.textContent).not.toMatch(/\d/);
    expect(container.textContent).not.toContain("setupElapsed");
  });

  it("counts up while the signer is being set up, so the wait is visibly alive", () => {
    // The stage from a real field report: assets are in hand, and the worker is
    // inside one long blocking call that cannot report from within. Nothing
    // else on screen moves, so without a counter this is indistinguishable
    // from a dead tab.
    useSapStore.setState({ stage: "setup", percent: null, error: null, hardwareID: "a1b2" } as any);

    vi.useFakeTimers();
    try {
      const { container } = render(<SapStatus />);
      expect(container.textContent).toContain("accounts.addForm.preparingSigner");

      // The seconds travel to t() as interpolation data, so read them back out
      // of the component's own rendering rather than assuming a format.
      const seconds = () =>
        Number(/"seconds":(\d+)/.exec(container.textContent!)![1]);

      expect(container.textContent).toContain("accounts.addForm.setupElapsed");
      expect(seconds()).toBe(0);

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(seconds()).toBe(3);

      act(() => {
        vi.advanceTimersByTime(9000);
      });
      expect(seconds()).toBe(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops counting once the signer leaves the setup stage", () => {
    useSapStore.setState({ stage: "setup", percent: null, error: null, hardwareID: "a1b2" } as any);

    vi.useFakeTimers();
    try {
      const { container } = render(<SapStatus />);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(container.textContent).toContain('"seconds":5');

      act(() => {
        useSapStore.setState({ stage: "ready", percent: null } as any);
      });
      // Renders nothing once ready — and the interval must be gone with it.
      expect(container.textContent).toBe("");

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(container.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
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
