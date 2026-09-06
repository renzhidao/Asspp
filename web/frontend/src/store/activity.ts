import { create } from "zustand";

/**
 * What the app tried to do, and how it went.
 *
 * The diagnostics report only ever covered SAP setup. A user whose download
 * failed could send a report and it would say nothing about the download — not
 * what was searched, not what was clicked, not what Apple answered. Setup is
 * one thing the app does; this records the rest.
 */
export interface ActivityEntry {
  at: number;
  kind: "search" | "license" | "download" | "versions" | "authenticate";
  /** What it was about, as the user would recognise it. Never a credential. */
  target: string;
  ok: boolean;
  /** The failure, when it failed. Apple's own wording where there is one. */
  detail?: string;
  /** Milliseconds the attempt took. */
  tookMs?: number;
}

/**
 * A bounded ring. A session of clicking around produces dozens of entries and
 * the report is meant to be pasted into a chat, so it cannot grow without end.
 * The oldest entries are the least useful: whatever broke is recent.
 */
const LIMIT = 40;

interface ActivityStore {
  entries: ActivityEntry[];
  record: (entry: Omit<ActivityEntry, "at"> & { at?: number }) => void;
}

export const useActivityStore = create<ActivityStore>()((set) => ({
  entries: [],
  record: (entry) =>
    set((state) => ({
      entries: [...state.entries, { at: Date.now(), ...entry }].slice(-LIMIT),
    })),
}));
