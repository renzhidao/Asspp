import { describe, it, expect, beforeEach } from "vitest";
import { useActivityStore } from "../../src/store/activity";
import { buildDiagnostics } from "../../src/utils/diagnostics";

// A report from a failed download used to say nothing about the download.

beforeEach(() => useActivityStore.setState({ entries: [] }));

describe("the activity log", () => {
  it("keeps what was tried and how it went", () => {
    const { record } = useActivityStore.getState();
    record({ kind: "license", target: "番茄小说", ok: true, tookMs: 900 });
    record({ kind: "download", target: "番茄小说", ok: false, detail: "响应中没有项目 (store=143465 keys=dialog,pings)" });

    const entries = useActivityStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("license");
    expect(entries[1].ok).toBe(false);
  });

  it("stops growing, oldest first", () => {
    const { record } = useActivityStore.getState();
    for (let i = 0; i < 60; i++) {
      record({ kind: "search", target: `app ${i}`, ok: true });
    }
    const entries = useActivityStore.getState().entries;
    expect(entries.length).toBeLessThanOrEqual(40);
    // Whatever broke is recent, so the recent end is what survives.
    expect(entries[entries.length - 1].target).toBe("app 59");
  });
});

describe("the report", () => {
  const base = {
    generatedAt: "2026-09-06T15:28:50.808Z",
    browser: { userAgent: "x", language: "zh-CN", page: "p", secureContext: true, worker: "available" },
    device: { cpuCores: 8, deviceMemoryGB: 16, platform: "Windows", visibilityState: "visible" },
    signer: { stage: "idle", percent: null, setupSeconds: null, events: [], error: null, hardwareID: null },
    accounts: [],
    language: "zh-CN",
  } as never;

  it("says so when nothing was tried", () => {
    const report = buildDiagnostics(base);
    expect(report).toContain("[activity]");
    expect(report).toContain("none recorded");
  });

  it("names the app and the reason it failed", () => {
    useActivityStore.getState().record({
      kind: "download",
      target: "番茄小说",
      ok: false,
      detail: "响应中没有项目 (store=143465 keys=dialog,pings)",
      tookMs: 1400,
    });

    const report = buildDiagnostics({
      ...base,
      activity: useActivityStore.getState().entries,
    } as never);

    expect(report).toContain("download");
    expect(report).toContain("番茄小说");
    expect(report).toContain("FAILED");
    expect(report).toContain("store=143465");
    // The setup timeline also prints "none recorded" when it is empty, so this
    // has to look at the activity section on its own.
    const section = report.slice(report.indexOf("[activity]"));
    expect(section).not.toContain("none recorded");
  });
});
