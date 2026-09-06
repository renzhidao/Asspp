import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useActivityStore } from "../store/activity";
import { useDownloadsStore } from "../store/downloads";
import { getDownloadInfo, DownloadError } from "../apple/download";
import { purchaseApp, PurchaseError } from "../apple/purchase";
import { authenticate } from "../apple/authenticate";
import { apiPost, apiGet } from "../api/client";
import { accountHash } from "../utils/account";
import { getErrorMessage } from "../utils/error";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const recordActivity = useActivityStore((s) => s.record);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  async function startDownload(
    account: Account,
    app: Software,
    versionId?: string,
  ) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;
    const beganAt = Date.now();

    try {
      await runDownload(account, app, versionId, appName, ctx);
      recordActivity({ kind: "download", target: appName, ok: true, tookMs: Date.now() - beganAt });
    } catch (error) {
      recordActivity({
        kind: "download",
        target: appName,
        ok: false,
        detail: getErrorMessage(error, "unknown"),
        tookMs: Date.now() - beganAt,
      });
      throw error;
    }
  }

  async function runDownload(
    account: Account,
    app: Software,
    versionId: string | undefined,
    appName: string,
    ctx: ReturnType<typeof getAccountContext>,
  ) {

    try {
      const settings = await apiGet<{ maxDownloadMB: number }>("/api/settings");
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          addToast(
            t("toast.downloadLimit.message", {
              appName,
              size: sizeMB.toFixed(2),
              limit: settings.maxDownloadMB,
            }),
            "error",
            t("toast.title.downloadLimit"),
          );
          return;
        }
      }
    } catch {
      // Settings fetch failed — backend will still enforce the limit
    }

    let licenseAccount = account;
    let { output, updatedCookies } = await getDownloadInfo(
      licenseAccount,
      app,
      versionId,
    ).catch(async (error: unknown) => {
      // 9610 is Apple saying the account has no licence for this app yet.
      // Acquiring one needs no signature — only the passwordToken and cookies
      // already on the account — so get it and carry on instead of making the
      // click the thing that has to happen first.
      if (!(error instanceof DownloadError) || error.code !== "9610") throw error;

      let licensed: Awaited<ReturnType<typeof purchaseApp>>;
      try {
        licensed = await purchaseApp(licenseAccount, app);
      } catch (licenseError) {
        // The licence is the reason there was nothing to download, so its
        // failure is the answer. Letting it go left the user holding "no items
        // in response" with the actual reason thrown away.
        const reason = getErrorMessage(licenseError, "unknown");
        throw new DownloadError(
          `${getErrorMessage(error, "unknown")} — ${reason}`,
          error.code,
        );
      }

      licenseAccount = { ...licenseAccount, cookies: licensed.updatedCookies };
      await updateAccount(licenseAccount);
      return getDownloadInfo(licenseAccount, app, versionId);
    });
    await updateAccount({ ...licenseAccount, cookies: updatedCookies });
    const hash = await accountHash(licenseAccount);

    await apiPost("/api/downloads", {
      software: { ...app, version: output.bundleShortVersionString },
      accountHash: hash,
      downloadURL: output.downloadURL,
      sinfs: output.sinfs,
      iTunesMetadata: output.iTunesMetadata,
    });

    fetchTasks();

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "info",
      t("toast.title.downloadStarted"),
    );
  }

  async function acquireLicense(account: Account, app: Software) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;
    const beganAt = Date.now();

    try {
      await runLicense(account, app, appName, ctx);
      recordActivity({ kind: "license", target: appName, ok: true, tookMs: Date.now() - beganAt });
    } catch (error) {
      recordActivity({
        kind: "license",
        target: appName,
        ok: false,
        detail: getErrorMessage(error, "unknown"),
        tookMs: Date.now() - beganAt,
      });
      throw error;
    }
  }

  async function runLicense(
    account: Account,
    app: Software,
    appName: string,
    ctx: ReturnType<typeof getAccountContext>,
  ) {

    // Renewing the token used to happen first, unconditionally. authenticate()
    // begins with prepareSigner(), and the signer lives in worker memory, so
    // that defensive refresh cost a whole SAP setup on every click — several
    // minutes on the devices that have been measured. The purchase only needs
    // the passwordToken and cookies already on the account, so try it with
    // those and sign in again only once Apple says the token has expired.
    let currentAccount = account;
    let result: Awaited<ReturnType<typeof purchaseApp>>;

    try {
      result = await purchaseApp(currentAccount, app);
    } catch (error) {
      const expired =
        error instanceof PurchaseError &&
        (error.code === "2034" || error.code === "2042");
      if (!expired) throw error;

      const renewed = await authenticate(
        account.email,
        account.password,
        undefined,
        account.cookies,
        account.deviceIdentifier,
      );
      await updateAccount(renewed);
      currentAccount = renewed;
      result = await purchaseApp(currentAccount, app);
    }

    await updateAccount({ ...currentAccount, cookies: result.updatedCookies });

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "success",
      t("toast.title.licenseSuccess"),
    );
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.downloadFailed")),
      }),
      "error",
      t("toast.title.downloadFailed"),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.licenseFailed")),
      }),
      "error",
      t("toast.title.licenseFailed"),
    );
  }

  return {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
  };
}
