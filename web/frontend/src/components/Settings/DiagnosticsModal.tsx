import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../common/Modal";
import Spinner from "../common/Spinner";
import { apiGet } from "../../api/client";
import { useAccountsStore } from "../../store/accounts";
import { useSapStore } from "../../store/sap";
import {
  buildDiagnostics,
  maskHardwareID,
  type SapAssetsStatus,
  type ServerSettings,
} from "../../utils/diagnostics";
import { useToastStore } from "../../store/toast";

/**
 * Everything needed to explain a failed sign-in, in one block that can be
 * pasted into an issue or saved to a file.
 *
 * Gathering it is a button rather than a set of instructions because the
 * alternative is asking someone to open a console, find the right error, and
 * judge which surrounding lines matter — and the fields that actually decide
 * the diagnosis (whether the assets verified, what the server answered) are not
 * in the console at all.
 */
export default function DiagnosticsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const accounts = useAccountsStore((state) => state.accounts);
  const { stage, percent, error, hardwareID } = useSapStore();
  const addToast = useToastStore((state) => state.addToast);

  const [report, setReport] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      setCollecting(true);
      setReport(null);

      // Each section is fetched on its own so one unreachable endpoint does
      // not take the rest of the report with it — and "unreachable" is often
      // the finding.
      const [server, serverError] = await apiGet<ServerSettings>(
        "/api/settings",
      )
        .then((value) => [value, null] as const)
        .catch((e) => [null, e instanceof Error ? e.message : String(e)] as const);

      const [sapAssets, sapAssetsError] = await apiGet<SapAssetsStatus>(
        "/api/sap/assets",
      )
        .then((value) => [value, null] as const)
        .catch((e) => [null, e instanceof Error ? e.message : String(e)] as const);

      if (cancelled) return;

      setReport(
        buildDiagnostics({
          server,
          serverError,
          sapAssets,
          sapAssetsError,
          signer: {
            stage,
            percent,
            error,
            hardwareID: maskHardwareID(hardwareID),
          },
          accounts,
          language: i18n.language,
        }),
      );
      setCollecting(false);
    })();

    return () => {
      cancelled = true;
    };
    // Re-collected each time the modal opens, not on every store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function copy() {
    if (!report) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
      } else {
        // Older Safari on iOS has no clipboard API outside a user gesture on
        // the element itself; the textarea route still works there.
        const area = document.createElement("textarea");
        area.value = report;
        area.style.position = "fixed";
        area.style.left = "-999999px";
        document.body.appendChild(area);
        area.focus();
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      addToast(t("settings.diagnostics.copied"), "success");
    } catch {
      addToast(t("settings.diagnostics.copyFailed"), "error");
    }
  }

  function download() {
    if (!report) return;
    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `assppweb-diagnostics-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Not revoked immediately: some browsers drop the download if the URL
    // disappears before the click has been handled.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <Modal open={open} onClose={onClose} title={t("settings.diagnostics.title")}>
      <div className="min-w-0 space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {t("settings.diagnostics.description")}
        </p>

        {collecting || !report ? (
          <div className="flex items-center gap-2 py-6 text-sm text-gray-500 dark:text-gray-400">
            <Spinner />
            {t("settings.diagnostics.collecting")}
          </div>
        ) : (
          <>
            {/* Selectable rather than read-only: on a phone, long-press to copy
                works even when the clipboard API does not. */}
            <pre
              className="max-h-72 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-800 select-text [overflow-wrap:anywhere] dark:bg-gray-950 dark:text-gray-200"
              aria-label={t("settings.diagnostics.reportLabel")}
            >
              {report}
            </pre>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={copy}
                className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              >
                {t("settings.diagnostics.copy")}
              </button>
              <button
                onClick={download}
                className="rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {t("settings.diagnostics.download")}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
