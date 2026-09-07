import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Acquiring a licence re-authenticates, and authenticating signs. The signer
// lives in worker memory, so a reload drops it and that click would otherwise
// sit through the entire setup again. useSapWarmup exists to rebuild it in the
// background — but nothing imported it, so it never ran.

const prepareSigner = vi.hoisted(() => vi.fn(() => Promise.resolve()));

// jsdom has no matchMedia, and App reads it for the theme.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }),
});

vi.mock("../src/apple/sap/client", () => ({ prepareSigner }));
vi.mock("../src/components/Auth/PasswordGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getAccessToken: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh-CN" },
    t: (key: string) => key,
  }),
}));

const { default: App } = await import("../src/App");
const { useAccountsStore } = await import("../src/store/accounts");
const { useSapStore } = await import("../src/store/sap");

describe("App", () => {
  beforeEach(() => {
    prepareSigner.mockClear();
    useSapStore.setState({
      stage: "idle",
      percent: null,
      setupStartedAt: null,
      lastError: null,
      error: null,
      hardwareID: null,
      events: [],
    });
  });

  it("starts rebuilding the signer once there is an account to bind it to", () => {
    useAccountsStore.setState({
      accounts: [
        {
          email: "richard@example.com",
          deviceIdentifier: "a1b2c3d4e5f6",
        } as never,
      ],
      loading: false,
    } as never);

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(prepareSigner).toHaveBeenCalledWith("a1b2c3d4e5f6");
  });

  it("does nothing while there is no account", () => {
    useAccountsStore.setState({ accounts: [], loading: false } as never);

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(prepareSigner).not.toHaveBeenCalled();
  });
});
