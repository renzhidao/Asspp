import { describe, expect, it } from "vitest";
import {
  buildDiagnostics,
  maskEmail,
  maskHardwareID,
  type DiagnosticsInput,
} from "../../src/utils/diagnostics";
import type { Account } from "../../src/types";

// The whole point of this report is that it can be pasted into a public issue.
// These tests hold it to that: the credential fields are given distinctive
// values, and the assertions are that those values do not appear anywhere.
const SECRET_PASSWORD = "hunter2-super-secret";
const SECRET_TOKEN = "AQ==passwordTokenThatMustNotLeak";
const SECRET_COOKIE = "despotlid=cookie-that-must-not-leak";
const SECRET_DSID = "1234567890-dsid-must-not-leak";
const GUID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const account: Account = {
  email: "richard@example.com",
  password: SECRET_PASSWORD,
  appleId: "1234567890",
  store: "143441",
  firstName: "Richard",
  lastName: "Testperson",
  passwordToken: SECRET_TOKEN,
  directoryServicesIdentifier: SECRET_DSID,
  cookies: [{ name: "despotlid", value: SECRET_COOKIE }],
  deviceIdentifier: GUID,
  pod: "25",
};

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    server: {
      buildCommit: "3bc9515",
      buildDate: "2026-09-06T00:00:00Z",
      uptime: 1234,
      port: 8080,
      dataDir: "/data",
      publicBaseUrl: "https://example.hf.space",
      downloadThreads: 8,
    },
    sapAssets: {
      available: ["CommerceKit"],
      missing: ["CoreFP", "CoreFP.icxs"],
      corrupt: [],
      ready: false,
      fetching: false,
      progress: { stage: "locating", found: [] },
      error: null,
    },
    signer: { stage: "assets", percent: 42, error: null, hardwareID: "a1b2…" },
    accounts: [account],
    language: "zh-CN",
    now: new Date("2026-09-06T08:00:00.000Z"),
    ...overrides,
  };
}

describe("masking", () => {
  it("keeps enough of an email to tell accounts apart and no more", () => {
    expect(maskEmail("richard@example.com")).toBe("r***@example.com");
  });

  it("does not reproduce a local part it cannot mask", () => {
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***");
  });

  it("keeps only a prefix of the device identifier", () => {
    expect(maskHardwareID(GUID)).toBe("a1b2…");
    expect(maskHardwareID(null)).toBeNull();
    // A short id has no safe prefix, so it is dropped rather than shown whole.
    expect(maskHardwareID("abcd")).toBe("***");
  });
});

describe("buildDiagnostics", () => {
  it("contains no credential from any account", () => {
    const report = buildDiagnostics(input());

    for (const secret of [
      SECRET_PASSWORD,
      SECRET_TOKEN,
      SECRET_COOKIE,
      SECRET_DSID,
      GUID,
      "richard@example.com",
      "Richard",
      "Testperson",
    ]) {
      expect(report).not.toContain(secret);
    }

    // And says so, so the reader is not taking it on trust.
    expect(report).toContain("no password, passwordToken, cookie or DSID");
  });

  it("still reports what is useful about each account", () => {
    const report = buildDiagnostics(input());

    expect(report).toContain("count: 1");
    expect(report).toContain("r***@example.com");
    expect(report).toContain("store=143441");
    expect(report).toContain("hasPassword=yes");
    expect(report).toContain("guid=a1b2…");
  });

  it("reports an account with no password as such", () => {
    const report = buildDiagnostics(
      input({ accounts: [{ ...account, password: "" }] }),
    );

    expect(report).toContain("hasPassword=no");
  });

  it("reports the SAP asset state, which is what decides most diagnoses", () => {
    const report = buildDiagnostics(input());

    expect(report).toContain("[sap assets]");
    expect(report).toContain("ready: false");
    expect(report).toContain("available: CommerceKit");
    expect(report).toContain("missing: CoreFP, CoreFP.icxs");
    expect(report).toContain("stage: locating");
  });

  it("keeps a multi-line server error readable rather than escaping it", () => {
    const report = buildDiagnostics(
      input({
        sapAssets: {
          ready: false,
          error:
            "cannot reach swcdn.apple.com: TLS disconnected.\nSet SAP_ASSETS_DIR.",
        },
      }),
    );

    expect(report).toContain("    cannot reach swcdn.apple.com: TLS disconnected.");
    expect(report).toContain("    Set SAP_ASSETS_DIR.");
    expect(report).not.toContain("\\n");
  });

  it("survives a server that cannot be reached at all", () => {
    const report = buildDiagnostics(
      input({ server: null, serverError: "Failed to fetch", sapAssets: null }),
    );

    expect(report).toContain("unreachable: Failed to fetch");
    expect(report).toContain("unreadable: unknown");
    // The rest of the report is still there — a dead API is a finding, not a
    // reason to hand back nothing.
    expect(report).toContain("[browser]");
    expect(report).toContain("[signer]");
  });

  it("includes the signer stage and its error", () => {
    const report = buildDiagnostics(
      input({
        signer: {
          stage: "error",
          percent: null,
          error: "timed out preparing the SAP signer",
          hardwareID: "a1b2…",
        },
      }),
    );

    expect(report).toContain("stage: error");
    expect(report).toContain("    timed out preparing the SAP signer");
  });

  it("identifies the build and the browser, since fixes land per build", () => {
    const report = buildDiagnostics(input());

    expect(report).toContain("buildCommit: 3bc9515");
    expect(report).toContain("generated: 2026-09-06T08:00:00.000Z");
    expect(report).toContain("language: zh-CN");
    expect(report).toContain("secureContext:");
    expect(report).toContain("worker:");
  });

  it("reads as plain text, not as something that needs a terminal", () => {
    const report = buildDiagnostics(input());

    expect(report).not.toMatch(/[\u001b\u009b]/);
    expect(report).not.toContain("<");
    expect(report.split("\n").every((l) => l.length < 200)).toBe(true);
  });

  it("handles having no accounts", () => {
    const report = buildDiagnostics(input({ accounts: [] }));

    expect(report).toContain("count: 0");
    expect(report).not.toContain("  - ");
  });
});
