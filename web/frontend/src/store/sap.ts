import { create } from "zustand";

// Readiness of the SAP signer, shared so any screen can show what it is doing.
//
// Preparing it takes a minute or two — 38 MB of Apple binaries and ten million
// emulated instructions — so it starts on its own in the background as soon as
// there is an account to prepare it for. A button pressed while that is under
// way shows the progress already being made instead of starting over in
// silence.

/**
 * One setup step beginning or ending.
 *
 * Kept as a flat list rather than folded into a per-step object so that a step
 * which never ends is visible as an entry with no matching end — that entry is
 * the answer to "where did it stop?".
 */
export interface SapEvent {
  /** Which step, e.g. `machine.initialize`. */
  label: string;
  /** Epoch milliseconds. */
  at: number;
  /** Present once the step finished; absent while it is still running. */
  endedAt?: number;
}

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
  /**
   * Why the previous attempt failed, kept across retries.
   *
   * A retry used to clear the error, so the one piece of evidence about the
   * attempt that just died was erased by the act of trying again — and "the
   * status line disappeared" was left with nothing behind it.
   */
  lastError: string | null;
  /**
   * Every setup step of the current attempt, oldest first.
   *
   * Setup is minutes long and reports no progress, so after the fact the only
   * evidence of what happened is this list. Bounded, because a session can
   * retry several times and a report has to stay pasteable.
   */
  events: SapEvent[];
  error: string | null;
  /** The hardware id the signer was prepared for. */
  hardwareID: string | null;

  begin: (hardwareID: string) => void;
  setInstalling: () => void;
  setAssets: (percent: number) => void;
  setSetup: () => void;
  setReady: () => void;
  setError: (message: string) => void;
  recordEvent: (event: SapEvent) => void;
}

/** Enough for several full attempts, and still a short report. */
const MAX_EVENTS = 80;

export const useSapStore = create<SapStore>((set) => ({
  stage: "idle",
  percent: null,
  setupStartedAt: null,
  lastError: null,
  events: [],
  error: null,
  hardwareID: null,

  // A new attempt starts from nothing. The events used to survive, so the
  // next report mixed two attempts and measured its timeline from the first
  // event of the previous one — which read as a step starting 118 seconds
  // into a setup that was 13 seconds old.
  begin: (hardwareID) =>
    set((state) => ({
      stage: "assets",
      percent: 0,
      setupStartedAt: null,
      events: [],
      lastError: state.error ?? state.lastError,
      error: null,
      hardwareID,
    })),
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
  recordEvent: (event) =>
    set((state) => {
      // A step's end arrives as a second event for the same label. Folding it
      // into the entry already there keeps one line per step; appending it
      // instead left the begin entry behind, so the list read as though every
      // finished step were also still running.
      //
      // Only the trailing open entry for that label is folded, so a signer
      // rebuilt mid-session appends a fresh machine.open rather than editing
      // the recorded cost of the first one.
      for (let index = state.events.length - 1; index >= 0; index--) {
        const existing = state.events[index];
        if (existing.label !== event.label) continue;
        if (existing.endedAt === undefined && event.endedAt !== undefined) {
          const folded = state.events.slice();
          folded[index] = { ...existing, endedAt: event.endedAt };
          return { events: folded };
        }
        break;
      }

      return { events: [...state.events, event].slice(-MAX_EVENTS) };
    }),
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
