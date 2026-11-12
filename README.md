# Anilarper public media (Backblaze B2 + Cloudflare Worker)

The media API runs on a Cloudflare Worker and stores MP4 files in a **private Backblaze B2 bucket**. The Worker is the only component that holds the storage credentials. It exposes a public video catalog and byte-range streaming endpoint while keeping the B2 bucket and its keys private.

This setup does not make storage or bandwidth unlimited. Check the current Backblaze and Cloudflare usage pages before sharing the service widely. Do not enable paid add-ons or enter payment details without a parent/guardian.

## Architecture and security

- Backblaze bucket: `anilarper-media` in region `us-east-005`.
- Bucket access should remain **Private**. Do not switch it to Public.
- `GET /api/videos` and `GET /media/{id}` are public through the Worker. The Worker signs requests to the private B2 bucket and streams the response, including HTTP byte ranges.
- When `PHONE_ORIGIN` is configured, the Worker also reads the backup phone's catalog and storage report and proxies phone-hosted MP4 streams over HTTPS. The phone must remain online for those videos to play.
- Upload, edit, delete, and multipart endpoints require the separate Worker secret `ADMIN_TOKEN`.
- The B2 Application Key ID and Application Key are Worker secrets named `B2_KEY_ID` and `B2_APP_KEY`. Never put them in the Android app, browser JavaScript, GitHub, screenshots, or chat.
- Use a standard, bucket-scoped application key, not the Backblaze master key. Backblaze's S3-compatible API uses Signature Version 4 and maps the Application Key ID to the access key ID and the Application Key to the secret access key.
- Only upload MP4 files that you own or have permission to distribute. Public Worker links can be copied and shared by anyone.

## One-time setup

Have a parent/guardian help with account agreements, eligibility, and any billing-related screens. Keep both services on their free plans; do not add a paid plan or paid add-on.

### 1. Backblaze B2

1. In B2 Cloud Storage, confirm the bucket is named `anilarper-media`, is in region `us-east-005`, and is **Private**.
2. Create a standard Application Key named `anilarper-worker`.
3. Limit the key to the `anilarper-media` bucket and choose **Read and Write**.
4. Save the Application Key ID and the Application Key privately. Backblaze only displays the secret Application Key when it is created.
5. Do not use the master application key. The Worker does not need permission to list all bucket names because it addresses the bucket directly.

### 2. Cloudflare Worker

From this folder, install the pinned dependency and Wrangler:

```sh
npm install
npx wrangler login
```

Add the three secrets. Each command prompts for the value; enter it directly into the private terminal prompt. Do not put the values in a command-line argument, source file, or GitHub Actions log.

```sh
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
npx wrangler secret put ADMIN_TOKEN
```

Use a long, unique random value for `ADMIN_TOKEN`. Keep it private. The endpoint, region, and bucket name are already set as non-secret variables in `wrangler.toml`.

Deploy:

```sh
npm test
npm run check
npx wrangler deploy
```

Wrangler prints a URL similar to `https://anilarper-media-api.<your-subdomain>.workers.dev`. Open that URL plus `/admin` to upload and manage videos. Enter only the Worker admin token on that HTTPS admin page.

In Anilarper Community Videos, enter the Worker URL without `/admin` and tap Connect.

## Backup-phone storage integration

The Worker can expose the backup phone and Backblaze as one Community Videos library. The phone server must run behind a secure HTTPS Cloudflare Tunnel; never port-forward the Termux HTTP server or expose port 8765 directly.

1. Keep the Termux media server running on the backup phone.
2. Create a Cloudflare Tunnel that forwards its private service to `http://127.0.0.1:8765`.
3. Set the Worker's non-secret `PHONE_ORIGIN` variable to the tunnel's HTTPS hostname (origin only, no path).
4. Install the Anilarper phone-server update that adds `GET /api/storage`.
5. Verify `GET /api/videos` from the Worker reports `storage.phone.online: true` and includes phone-hosted videos.

The Worker then combines cloud catalog usage with the phone filesystem's used/total/free bytes. Cloud and phone video copies are deduplicated in the visible catalog when title and size match, while actual physical storage usage still counts both copies. Phone-hosted playback is proxied through the Worker and supports byte ranges.

**Important:** this combines the library and capacity reporting; it does not turn Backblaze's 10 GB upload quota into a larger B2 quota. Videos stored on the phone are served from the phone, so the phone must have power, internet, and Termux running. If the phone is offline, its videos cannot be streamed and its storage is temporarily excluded from the live total.

## API

- `GET /api/health` — health and storage cap.
- `GET /api/videos` — public catalog in the format Anilarper already reads.
- `GET/HEAD /media/{id}` — public MP4 stream with HTTP byte-range support.
- `POST /api/upload/start`, `PUT /api/upload/part`, `POST /api/upload/complete`, `POST /api/upload/abort` — authenticated multipart upload.
- `POST /api/videos/{id}/metadata` — authenticated title/category edit.
- `DELETE /api/videos/{id}` — authenticated deletion.

Uploads use 8 MiB parts. Individual videos are capped at 5 GiB and completed plus pending uploads at 10,000,000,000 bytes. The Worker checks the actual completed object size before publishing it in the catalog.

## Cost and usage notes

- Backblaze storage, download/egress, and transaction allowances are separate. The 10 GB app-side cap is only a guardrail; it does not guarantee that all downloads remain free.
- Cloudflare Worker requests also have plan limits. Video players can make multiple range requests while seeking, so public traffic can use requests faster than expected.
- Monitor both providers' usage and billing dashboards. If either provider asks for payment information or a plan change, stop and have a parent/guardian review it before proceeding.
- This Worker does not configure a custom domain, public B2 bucket, or direct public B2 URL.

## Local checks and deployment status

Run `npm test` and `npm run check` from this directory. The tests use an in-memory S3-compatible mock; they do not prove that the real Backblaze key, bucket, account limits, or Cloudflare deployment works. After deployment, verify `/api/health`, upload a small MP4 from `/admin`, play it in Anilarper, seek within it, and delete it.

The repository changes do not create provider accounts, store secrets, or deploy the Worker on your behalf.

---

## AI-assisted development

> **Vibe coded with AI.** This project was built and iterated on with AI assistance, guided by human ideas, prompts, testing, and decisions. AI-generated contributions may contain mistakes; review and verify changes before use.
