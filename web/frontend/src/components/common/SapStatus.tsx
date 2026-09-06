import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSapStore } from "../../store/sap";

/**
 * What the SAP signer is doing, for screens with a button that will wait on
 * it. Renders nothing when it is idle or ready, so it can be dropped in
 * without reserving space for the common case.
 *
 * The signer starts preparing in the background on load, so this is usually
 * showing progress already under way rather than something a press started.
 *
 * `col-span-full` keeps it from eating a track of its own when the parent is a
 * grid — ProductDetail lays its actions out with `grid-flow-col auto-cols-fr`,
 * where an always-present wrapper would squeeze the buttons even while this
 * renders nothing. The class is inert in the flex parents it is also used in.
 */
export default function SapStatus() {
  const { t } = useTranslation();
  const stage = useSapStore((state) => state.stage);
  const percent = useSapStore((state) => state.percent);
  const error = useSapStore((state) => state.error);

  // Setting a signer up is a long, single-threaded wait inside the worker, and
  // the worker cannot report from inside it — so from outside it is
  // indistinguishable from a dead tab. The download and install phases have
  // real numbers to show; this one has none, so it counts up instead. A number
  // that moves is the only honest "still working" available here, and the wait
  // is long enough that a fixed estimate reads as a hang once it is passed.
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (stage !== "setup") {
      setElapsed(0);
      return;
    }

    const startedAt = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [stage]);

  if (stage === "idle" || stage === "ready") return null;

  if (stage === "error") {
    return (
      <span className="col-span-full flex items-center text-sm text-red-600 dark:text-red-400">
        {t("accounts.addForm.signerFailed", { error: error ?? "" })}
      </span>
    );
  }

  return (
    <span className="col-span-full flex items-center text-sm text-gray-600 dark:text-gray-400">
      {stage === "assets"
        ? t("accounts.addForm.preparingAssets", { percent: percent ?? 0 })
        : stage === "installing"
          ? t("accounts.addForm.installingAssets")
          : `${t("accounts.addForm.preparingSigner")} ${t(
              "accounts.addForm.setupElapsed",
              { seconds: elapsed },
            )}`}
    </span>
  );
}
