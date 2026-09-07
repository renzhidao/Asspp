# AssppWeb

A web-based tool for acquiring and installing iOS apps outside the App Store. Authenticate with your Apple ID, search for apps, acquire licenses, and install IPAs directly to your device.

![preview](./resources/preview.png)

## Zero-Trust Architecture

AssppWeb uses a zero-trust design where the server **never sees your Apple credentials**. All Apple API communication happens directly in your browser via WebAssembly (libcurl.js with Mbed TLS 1.3). The server only acts as a blind TCP relay (Wisp protocol) and handles IPA compilation from public CDN downloads.

> **⚠️ Important Security Notice:** There are no official Asspp Web instances. Use any public instance at your own risk. While the backend cannot read your encrypted traffic, a malicious host could serve a modified frontend to capture your credentials before encryption. Therefore, **do not blindly trust public instances**. We strongly recommend self-hosting your own instance or using one provided by a trusted partner. Always verify the SSL certificate and ensure you are connecting to a secure, authentic endpoint.

**恳请所有转发项目的博主对自己的受众进行网络安全技术科普。要有哪个不拎清的大头儿子搞出事情来都够我们喝一壶的。**

## Quick Start

### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Lakr233/AssppWeb&apiTokenTmpl=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22write%22%7D%2C%7B%22key%22%3A%22containers%22%2C%22type%22%3A%22write%22%7D%2C%7B%22key%22%3A%22cloudchamber%22%2C%22type%22%3A%22write%22%7D%5D&apiTokenName=AssppWeb%20Deploy)

This uses Cloudflare Workers + Containers with the published image `ghcr.io/lakr233/assppweb:latest`.

Requirements:

- Cloudflare Workers **Paid** plan (Containers are not available on Free).
- Deploy/build token with:
  - `Workers Scripts Edit`
  - `Containers Edit`
  - `Cloudchamber Edit`

If your build log fails at `Deploy a container application` with `Unauthorized`, your build token is missing required Containers/Cloudchamber permissions.

### Deploy to Railway

<details>
<summary>Click to show Railway deployment instructions</summary>

1. Go to [railway.com/new/image](https://railway.com/new/image) → enter `ghcr.io/lakr233/assppweb:latest`
2. In service **Settings**, set **Healthcheck Path** to `/api/settings` and deploy
3. Right-click the service → **Attach volume** → mount path: `/data`
4. In **Variables**, set `DATA_DIR` = `/data` and deploy
5. In **Settings** → **Networking**, generate a public domain or add a custom domain

**Notes**

- The free trial works but has limitations (volume expiry, network restrictions). **Hobby** plan ($5/month) or above is recommended for reliable use.
- Enable [**Serverless**](https://docs.railway.com/deployments/serverless) in service settings to scale down to zero during idle periods
- Railway [auto-updates](https://docs.railway.com/deployments/image-auto-updates) `:latest` images from GHCR — new releases will be deployed automatically within a few hours

> **⚠️ Custom domain with Cloudflare:** Railway's Cloudflare integration creates DNS records with Proxy enabled (orange cloud) by default. After authorizing, go to Cloudflare DNS settings and switch the CNAME record to **DNS only** (gray cloud) — Railway handles TLS automatically. If you keep Cloudflare Proxy on, you must set SSL/TLS mode to **Full** (not Flexible or Full Strict), otherwise you'll get an infinite redirect loop. See [Railway docs](https://docs.railway.com/networking/troubleshooting/ssl#err_too_many_redirects).

</details>

### Self-Host with Docker Compose

<details>
<summary>Click to show manual Docker Compose setup instructions</summary>

**Setup Docker Compose**

```bash
curl -O https://raw.githubusercontent.com/Lakr233/AssppWeb/main/compose.yml
docker compose up -d
```

**Environment Variables**

| Variable                                    | Default         | Description                                                                                 |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `PORT`                                      | `8080`          | Server listen port                                                                          |
| `DATA_DIR`                                  | `./data`        | Directory for storing compiled IPAs                                                         |
| `PUBLIC_BASE_URL`                           | _(auto-detect)_ | Public URL for generating install manifests (e.g. `https://asspp.example.com`)              |
| `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT` | `false`         | Disable HTTPS redirect (see warning below)                                                  |
| `AUTO_CLEANUP_DAYS`                         | `0`             | Automatically delete cached IPA files older than specified days (0 to disable)              |
| `AUTO_CLEANUP_MAX_MB`                       | `0`             | Automatically delete oldest cached IPA files when size exceeds this MB limit (0 to disable) |
| `MAX_DOWNLOAD_MB`                           | `0`             | Reject downloads exceeding this size in MB to prevent out-of-memory errors (0 to disable)   |
| `DOWNLOAD_THREADS`                          | `8`             | Number of parallel threads for IPA downloads (1–32)                                         |
| `ACCESS_PASSWORD`                           | _(none)_        | Require a password to access the web UI and API (empty to disable)                          |
| `SAP_ASSETS_DIR`                            | _(DATA_DIR/sap)_ | Where the SAP signer's Apple binaries live. Set it when the host cannot reach `swcdn.apple.com` and the files must be supplied by hand — point it at a persistent volume, or they vanish on every restart |

**Reverse Proxy (Required for Install Apps on iOS)**

iOS requires HTTPS for `itms-services://` install links. You must put AssppWeb behind a reverse proxy with a valid TLS certificate.

> **⚠️ Redirect loop (`ERR_TOO_MANY_REDIRECTS`)?** Some reverse proxies (e.g. NAS built-in proxies) always send `X-Forwarded-Proto: http` even when the client connected via HTTPS, causing an infinite redirect loop. If you cannot configure your proxy to send the correct header, set `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT=true` as a last resort. **This disables the HTTP→HTTPS redirect — you must ensure your proxy enforces HTTPS externally.**

The following is an example Caddyfile configuration:

```
asspp.example.com { reverse_proxy 127.0.0.1:8080 }
```

**⚠️ Make Sure WebSocket Works**

AssppWeb relies on the Wisp protocol over WebSocket (`/wisp/`) for its zero-trust architecture. Ensure your reverse proxy or CDN (e.g., Nginx, Cloudflare) is configured to allow WebSocket connections, otherwise the app will fail to communicate with Apple servers.

</details>

## Sign-in and the SAP signature

Since August 2026 Apple rejects an `authenticate` request that carries no
`X-Apple-ActionSignature` with **HTTP 403 and an empty body**, before it looks
at the credentials. The live bag lists the affected endpoints under
`urlBag.sign-sap-request`. The UI reports this as
`认证失败：服务器返回 HTTP 403 且响应体为空` / "Authentication failed: server returned
HTTP 403 with an empty body".

Signing means running Apple's own signing code, so this build emulates the four
binaries from a 2013 OS X release in the browser, under
[unicorn.js](https://github.com/alexaltea/unicorn.js), inside a Web Worker:

- `POST /api/sap/assets/fetch` downloads them from Apple's software update CDN
  on first use and keeps them in `SAP_ASSETS_DIR`. `GET /api/sap/assets` reports
  which are present and verified — poll that rather than watching the server log.
- `GET /api/sap/certificate` and `POST /api/sap/setup` proxy the two SAP setup
  endpoints. Neither carries credentials; the only identity in the handshake is
  the device guid the client already sends in the clear, so the server still
  never sees an Apple password.

**Cost, so it is not a surprise:** setup runs about ten million emulated
instructions — roughly 35 s on WebKit and 115 s on Chrome — and each signature a
few million more. Setup starts in the background as soon as there is an account
to bind a signer to, and the button reports progress meanwhile. On a phone,
expect it to be slow and expect the memory to matter.

### Which version is running

Pass the commit and date at build time, or every deployment reports
`buildCommit: unknown` and there is no way to tell two of them apart from a
diagnostics report:

```bash
docker build \
  --build-arg BUILD_COMMIT="$(git rev-parse --short HEAD)" \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t assppweb:sap .
```

### `/tmp` is not storage

The image defaults `DATA_DIR` to `/data`. A deployment that sets it to
something under `/tmp` loses the 38 MB of SAP binaries on every restart and
downloads them again, which on a slow uplink looks like a hang at sign-in. Put
`DATA_DIR` on a volume — on a host with a persistent-storage option, that one;
anywhere else, a mounted volume.

### When the host cannot reach Apple's CDN

`swcdn.apple.com` is not reachable from everywhere. Rather than let sign-in
break with nothing to act on, the asset list can be supplied by hand:

1. On a machine that *can* reach Apple, run `node tools/fetch-sap-assets.mjs`.
2. Copy the resulting directory — the four binaries plus `sap-assets.json` — to
   the deployment, and set `SAP_ASSETS_DIR` to where you put it.

`sap-assets.json` describes what is expected there (name, path, size, SHA-256)
and overrides the built-in list, which is also how you point the signer at a
different build of those binaries. Every file is checked against its digest
before being served; a file of the right length but wrong contents is reported
as corrupt rather than handed to the emulator to fail on obscurely.

## Security Recommendations

**DDoS Protection**

IPA files can be hundreds of megabytes. If your instance is publicly accessible, put it behind a CDN like Cloudflare to absorb bandwidth and prevent abuse.

## License

MIT License. See [LICENSE](LICENSE) for details.

## 🥰 Acknowledgments

For projects that was stolen and used heavily:

- [ipatool](https://github.com/majd/ipatool)
- [Asspp](https://github.com/Lakr233/Asspp)

For friends who helped with testing and feedback:

- [@lbr77](https://github.com/lbr77)
- [@akinazuki](https://github.com/akinazuki)

<img src="./Artworks/fable5.jpg" alt="Fable 5 Verified" width="240">
