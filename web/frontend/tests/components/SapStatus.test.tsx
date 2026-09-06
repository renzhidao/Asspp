import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import SapStatus from "../../src/components/common/SapStatus";
import { useSapStore } from "../../src/store/sap";

// Interpolation options do not reach the screen through the repo's usual
// t: (key) => key mock, and the elapsed seconds travel as one, so they are
// rendered alongside the key here and read back out.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

const secondsIn = (text: string | null) =>
  Number(/"seconds":(\d+)/.exec(text ?? "")![1]);

describe("SapStatus during setup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSapStore.setState({
      stage: "idle",
      percent: null,
      setupStartedAt: null,
      error: null,
      hardwareID: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps counting from the real start when the screen unmounts and comes back", () => {
    // Reported from the field: navigating to another page and back reset the
    // count. The wait is many minutes long on a phone, so a clock that reads
    // zero again describes a setup that just began when one is nine minutes in.
    useSapStore.getState().setSetup();

    const first = render(<SapStatus />);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(secondsIn(first.container.textContent)).toBe(120);
    first.unmount();

    const second = render(<SapStatus />);
    expect(secondsIn(second.container.textContent)).toBe(120);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(secondsIn(second.container.textContent)).toBe(125);
  });

  it("does not carry the count over into a second setup", () => {
    useSapStore.getState().setSetup();
    const first = render(<SapStatus />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(secondsIn(first.container.textContent)).toBe(60);

    // A new attempt — the error path resets, then setup begins again.
    act(() => {
      useSapStore.getState().setError("boom");
      useSapStore.getState().setSetup();
    });
    expect(secondsIn(first.container.textContent)).toBe(0);
  });
});
