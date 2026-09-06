import { create } from "zustand";

// Readiness of the SAP signer, shared so any screen can show what it is doing.
//
// Preparing it takes a minute or two — 38 MB of Apple binaries and ten million
// emulated instructions — so it starts on its own in the background as soon as
// there is an account to prepare it for. A button pressed while that is under
// way shows the progress already being made instead of starting over in
// silence.

export type SapStage =
  | "idle"
  /** The server is still fetching the binaries from Apple. */
  | "installing"
  | "assets"
  | "setup"
  | "ready"
  | "error";

interface SapStore {
  stage: SapStage;
  /** 0 to 100 while assets download, null once past that. */
  percent: number | null;
  /**
   * When the setup stage began, in epoch milliseconds, or null outside it.
   *
   * Setup is the one long wait with no progress to report, so the screen
   * counts seconds instead — and that count has to survive the component that
   * renders it unmounting, or navigating away and back restarts it at zero and
   * makes a wait already nine minutes old look like one that just began.
   */
  setupStartedAt: number | null;
  error: string | null;
  /** The hardware id the signer was prepared for. */
  hardwareID: string | null;

  begin: (hardwareID: string) => void;
  setInstalling: () => void;
  setAssets: (percent: number) => void;
  setSetup: () => void;
  setReady: () => void;
  setError: (message: string) => void;
}

export const useSapStore = create<SapStore>((set) => ({
  stage: "idle",
  percent: null,
  setupStartedAt: null,
  error: null,
  hardwareID: null,

  begin: (hardwareID) =>
    set({
      stage: "assets",
      percent: 0,
      setupStartedAt: null,
      error: null,
      hardwareID,
    }),
  setInstalling: () => set({ stage: "installing", percent: null }),
  setAssets: (percent) => set({ stage: "assets", percent }),
  // Timestamped once, on entry. Re-entering the stage is a fresh setup and
  // does get a fresh start, but a remount of the screen showing it does not.
  setSetup: () =>
    set((state) =>
      state.stage === "setup" && state.setupStartedAt !== null
        ? { stage: "setup", percent: null }
        : { stage: "setup", percent: null, setupStartedAt: Date.now() },
    ),
  setReady: () =>
    set({ stage: "ready", percent: null, setupStartedAt: null, error: null }),
  setError: (message) =>
    set({ stage: "error", percent: null, setupStartedAt: null, error: message }),
}));

/** A human-readable line for the current stage, or null when there is nothing to say. */
export function sapStatusKey(stage: SapStage): string | null {
  switch (stage) {
    case "assets":
      return "accounts.addForm.preparingAssets";
    case "setup":
      return "accounts.addForm.preparingSigner";
    case "error":
      return "accounts.addForm.signerFailed";
    default:
      return null;
  }
}
