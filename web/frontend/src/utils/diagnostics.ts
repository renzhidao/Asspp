import type { Account } from "../types";
import type { SapStage } from "../store/sap";

// Collects everything needed to diagnose a failed sign-in into one block of
// text that can be pasted into an issue.
//
// The point of the shape of this module is what it cannot contain. It takes
// accounts as input and emits only a count and a masked address per account,
// so there is no code path from a stored password, passwordToken, cookie or
// DSID into the report. A user should be able to paste this in public without
// having to read it line by line first — and the note at the top says so, so
// they are not taking that on faith either.

export interface ServerSettings {
  uptime?: number;
  buildCommit?: string;
  buildDate?: string;
  port?: number;
  dataDir?: string;
  publicBaseUrl?: string;
  disableHttpsRedirect?: boolean;
  autoCleanupDays?: number;
  autoCleanupMaxMB?: number;
  maxDownloadMB?: number;
  downloadThreads?: number;
}

export interface SapAssetsStatus {
  available?: string[];
  missing?: string[];
  corrupt?: string[];
  ready?: boolean;
  fetching?: boolean;
  progress?: { stage?: string; found?: string[] } | null;
  error?: string | null;
}

/** One setup step, as recorded by the store. See store/sap.ts. */
export interface SapEvent {
  label: string;
  at: number;
  endedAt?: number;
}

/**
 * The parts of the device that decide how long the emulation takes.
 *
 * Setup is emulated x86-64 code, so its cost tracks the hardware it runs on
 * far more than it tracks anything in the deployment — and every published
 * timing for it is a desktop. A report from a phone without these cannot be
 * compared to anything.
 */
export interface DeviceEnvironment {
  cpuCores?: number | null;
  deviceMemoryGB?: number | null;
  platform?: string | null;
  /** Whether the page has been backgrounded, which can suspend a worker. */
  visibilityState?: string | null;
}

export interface DiagnosticsInput {
  environment?: DeviceEnvironment | null;
  server?: ServerSettings | null;
  /** Why the server could not be read, if it could not be. */
  serverError?: string | null;
  sapAssets?: SapAssetsStatus | null;
  sapAssetsError?: string | null;
  signer: {
    stage: SapStage;
    percent: number | null;
    /**
     * How long the setup stage has been running, or null outside it.
     *
     * Setup is the one stage with no progress to report, and the only
     * measurements of it are on desktop and in Node — so "is it stuck?" cannot
     * be answered from the stage name alone. The elapsed time says how far
     * into a wait that has no other observable the reader is.
     */
    setupSeconds: number | null;
    /** Every setup step of the current attempt, oldest first. */
    events: SapEvent[];
    error: string | null;
    /** Why the previous attempt failed, if it did. */
    lastError?: string | null;
    /** Masked before it gets here; see maskHardwareID. */
    hardwareID: string | null;
  };
  accounts: Account[];
  language: string;
  now?: Date;
}

/** `richard@example.com` -> `r***@example.com`. Keeps enough to tell accounts apart. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Shortens the device identifier. The full guid is what a signer is bound to
 * and is sent to Apple on every request, so only a prefix goes in a report.
 */
export function maskHardwareID(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 4 ? "***" : `${id.slice(0, 4)}…`;
}

/**
 * The step setup is in right now, or null if every recorded step has ended.
 *
 * The last entry with no `endedAt` is the step still running. Its begin and
 * end carry the same label and the same start timestamp, so scanning back to
 * the begin entry of the final step gives the same answer as the end would —
 * which is what turns "stage: setup", which says only that something is
 * happening, into an answer.
 */
export function runningStep(events: SapEvent[]): SapEvent | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.endedAt === undefined) return event;
  }
  return null;
}

/**
 * Formats the recorded steps as a timeline relative to the first one, so the
 * gaps between steps are visible as well as the steps.
 *
 * A step that never ended has no `endedAt`, and is the answer to "where did it
 * stop?" — so it is marked rather than silently omitted.
 */
function setupTimeline(events: SapEvent[]): string[] {
  if (events.length === 0) return ["  none recorded"];

  const startedAt = events[0].at;
  const at = (timestamp: number) =>
    `+${((timestamp - startedAt) / 1000).toFixed(1)}s`;

  // One line per step. Where a begin and an end were recorded as separate
  // entries, the end is the one worth printing; a begin with nothing after it
  // is the step still in progress.
  const lines: string[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const supersededBy = events.findIndex(
      (later, position) => position > index && later.label === event.label,
    );

    if (supersededBy !== -1) {
      const end = events[supersededBy];
      index = supersededBy;
      if (end.endedAt === undefined) {
        lines.push(`  ${end.label}  ${at(end.at)}  STILL RUNNING`);
        continue;
      }
      lines.push(
        `  ${end.label}  ${at(end.at)}  took ${((end.endedAt - end.at) / 1000).toFixed(1)}s`,
      );
      continue;
    }

    lines.push(
      event.endedAt !== undefined
        ? `  ${event.label}  ${at(event.at)}  took ${((event.endedAt - event.at) / 1000).toFixed(1)}s`
        : `  ${event.label}  ${at(event.at)}  STILL RUNNING`,
    );
  }

  return lines;
}

function line(label: string, value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return `${label}: -`;
  }
  return `${label}: ${value}`;
}

/**
 * Builds the report. Never throws: a section that could not be read says so
 * inline, because "the server did not answer" is itself the useful finding.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const now = input.now ?? new Date();
  const out: string[] = [];

  out.push("AssppWeb diagnostics");
  out.push(`generated: ${now.toISOString()}`);
  out.push(
    "note: contains no password, passwordToken, cookie or DSID by construction.",
  );
  out.push("");

  out.push("[browser]");
  out.push(line("  userAgent", navigator.userAgent));
  out.push(line("  language", input.language));
  out.push(line("  page", location.origin));
  out.push(line("  secureContext", String(location.protocol === "https:")));
  out.push(
    line(
      "  worker",
      typeof Worker === "undefined" ? "unavailable" : "available",
    ),
  );
  out.push("");

  out.push("[device]");
  if (input.environment) {
    out.push(line("  cpuCores", input.environment.cpuCores));
    out.push(line("  deviceMemoryGB", input.environment.deviceMemoryGB));
    out.push(line("  platform", input.environment.platform));
    out.push(line("  visibilityState", input.environment.visibilityState));
  } else {
    out.push("  unavailable");
  }
  out.push("");

  out.push("[server]");
  if (input.server) {
    out.push(line("  buildCommit", input.server.buildCommit));
    out.push(line("  buildDate", input.server.buildDate));
    out.push(line("  uptimeSeconds", input.server.uptime));
    out.push(line("  port", input.server.port));
    out.push(line("  dataDir", input.server.dataDir));
    out.push(line("  publicBaseUrl", input.server.publicBaseUrl));
    out.push(
      line("  httpsRedirectDisabled", String(!!input.server.disableHttpsRedirect)),
    );
    out.push(line("  downloadThreads", input.server.downloadThreads));
    out.push(line("  maxDownloadMB", input.server.maxDownloadMB));
  } else {
    out.push(`  unreachable: ${input.serverError ?? "unknown"}`);
  }
  out.push("");

  out.push("[sap assets]");
  if (input.sapAssets) {
    out.push(line("  ready", String(!!input.sapAssets.ready)));
    out.push(line("  fetching", String(!!input.sapAssets.fetching)));
    out.push(
      line("  available", (input.sapAssets.available ?? []).join(", ")),
    );
    out.push(line("  missing", (input.sapAssets.missing ?? []).join(", ")));
    out.push(line("  corrupt", (input.sapAssets.corrupt ?? []).join(", ")));
    out.push(line("  stage", input.sapAssets.progress?.stage));
    out.push(
      line("  found", (input.sapAssets.progress?.found ?? []).join(", ")),
    );
    if (input.sapAssets.error) {
      out.push("  error:");
      for (const part of String(input.sapAssets.error).split("\n")) {
        out.push(`    ${part}`);
      }
    }
  } else {
    out.push(`  unreadable: ${input.sapAssetsError ?? "unknown"}`);
  }
  out.push("");

  out.push("[signer]");
  out.push(line("  stage", input.signer.stage));
  out.push(line("  percent", input.signer.percent));
  out.push(
    line(
      "  setupSeconds",
      input.signer.setupSeconds === null ? null : input.signer.setupSeconds,
    ),
  );
  out.push(line("  hardwareID", input.signer.hardwareID));

  // The one line the whole section exists for: not "setup is happening" but
  // which of setup's steps it is in, and for how long.
  const running = runningStep(input.signer.events);
  if (running) {
    const forSeconds = (Date.now() - running.at) / 1000;
    out.push(
      `  stuckInStep: ${running.label} for ${forSeconds.toFixed(0)}s`,
    );
  }

  out.push("  setupTimeline:");
  for (const entry of setupTimeline(input.signer.events)) out.push(entry);
  if (input.signer.error) {
    out.push("  error:");
    for (const part of String(input.signer.error).split("\n")) {
      out.push(`    ${part}`);
    }
  }
  // Kept across retries: a status line that vanishes and a fresh attempt that
  // looks clean are indistinguishable without it.
  if (input.signer.lastError) {
    out.push("  previousAttemptFailed:");
    for (const part of String(input.signer.lastError).split("\n")) {
      out.push(`    ${part}`);
    }
  }
  out.push("");

  out.push("[accounts]");
  out.push(line("  count", input.accounts.length));
  // Deliberately only these two fields per account. Everything else on an
  // Account is a credential or derived from one.
  for (const account of input.accounts) {
    out.push(
      `  - ${maskEmail(account.email)}  store=${account.store || "-"}  ` +
        `hasPassword=${account.password ? "yes" : "no"}  ` +
        `guid=${maskHardwareID(account.deviceIdentifier) ?? "-"}`,
    );
  }

  return out.join("\n");
}
