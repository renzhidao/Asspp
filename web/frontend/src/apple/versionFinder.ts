import type { Account, Software } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from "./config";

export async function listVersions(
  account: Account,
  app: Software,
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: "",
      guid: deviceId,
      salableAdamId: app.id,
      // Apple added a verification check on the volumeStore endpoint that only
      // some apps enforce — the big publishers do, ordinary ones do not, which
      // is why a few apps have always failed here while the rest worked. The
      // answer came back as "App Not Available" with an empty failureType, so
      // nothing in the response said what was missing. ipatool hit the same
      // wall and fixed it the same way (majd/ipatool#500, merged 2026-08-28).
      serialNumber: "0",
    };

    const plistBody = buildPlist(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-apple-plist",
      "iCloud-DSID": account.directoryServicesIdentifier,
      "X-Dsid": account.directoryServicesIdentifier,
    };

    const response = await appleRequest({
      method: "POST",
      host: requestHost,
      path: requestPath,
      headers,
      body: plistBody,
      cookies,
    });

    cookies = extractAndMergeCookies(response.rawHeaders, cookies);

    if (response.status === 302) {
      const location = response.headers["location"];
      if (!location) {
        throw new Error("Failed to retrieve redirect location");
      }
      const url = new URL(location);
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      continue;
    }

    const dict = parsePlist(response.body) as Record<string, any>;

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (!songList || songList.length === 0) {
      if (dict.failureType) {
        const failureType = String(dict.failureType);

        // volumeStore intermittently returns 5002; retry once via the
        // redownload dispatch endpoint, which serves the same payload.
        if (failureType === RETRYABLE_FAILURE_TYPE && !triedRedownload) {
          triedRedownload = true;
          endpoint = redownloadEndpoint(deviceId);
          requestHost = endpoint.host;
          requestPath = endpoint.path;
          redirectAttempt = 0;
          continue;
        }

        switch (failureType) {
          case "2034":
            throw new Error("Password token is expired (2034)");
          case "9610":
            throw new Error("License required - purchase the app first (9610)");
          default: {
            // The same dead end the download had: Apple's words alone, with the
            // code that says which rule refused left behind in the response.
            const msg = dict.customerMessage as string | undefined;
            throw new Error(
              msg
                ? `${msg} (${failureType})`
                : `No items in response (${failureType})`,
            );
          }
        }
      }
      // failureType is absent or empty here too — see download.ts. Print the
      // distinction rather than a message that looks like the coded ones.
      const code =
        dict.failureType === undefined || dict.failureType === null
          ? "absent"
          : String(dict.failureType) === ""
            ? "empty"
            : String(dict.failureType);
      const customerMessage =
        typeof dict.customerMessage === "string" && dict.customerMessage
          ? dict.customerMessage
          : undefined;
      throw new Error(
        `${customerMessage ?? "No items in response"} (code=${code})`,
      );
    }

    const item = songList[0];
    const metadata = item.metadata as Record<string, any>;
    if (!metadata) {
      throw new Error("Missing version identifiers");
    }

    const identifiers = metadata.softwareVersionExternalIdentifiers as any[];
    if (!identifiers) {
      throw new Error("Missing version identifiers");
    }

    const versions = identifiers.map((id) => String(id)).reverse();
    if (versions.length === 0) {
      throw new Error("No versions found");
    }

    return { versions, updatedCookies: cookies };
  }

  throw new Error("Too many redirects");
}
