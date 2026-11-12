import { AwsClient } from "aws4fetch";

const MAX_STORAGE_BYTES = 10_000_000_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_PART_BYTES = 10 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;
const CATALOG_KEY = "_anilarper/catalog.json";
const MEDIA_PREFIX = "media/";
const DEFAULT_ENDPOINT = "https://s3.us-east-005.backblazeb2.com";
const DEFAULT_REGION = "us-east-005";
const DEFAULT_BUCKET = "anilarper-media";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,Range,If-Range",
  "Access-Control-Expose-Headers": "Accept-Ranges,Content-Length,Content-Range,ETag",
  "Vary": "Origin"
};

function respond(body, status, headers) {
  const h = new Headers(headers || {});
  for (const k in cors) h.set(k, cors[k]);
  return new Response(body, { status: status || 200, headers: h });
}
function json(data, status) {
  return respond(JSON.stringify(data), status || 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
}
function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max || 120);
}
function safeFilename(value) {
  const name = String(value || "").split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._ -]/g, "_").trim().replace(/^[. ]+|[. ]+$/g, "");
  if (!name || !/\.mp4$/i.test(name)) throw new Error("Only MP4 files are accepted.");
  return name.slice(0, 150);
}
function isAdmin(request, env) {
  const supplied = request.headers.get("Authorization") || "";
  const expected = "Bearer " + (env.ADMIN_TOKEN || "");
  if (!env.ADMIN_TOKEN || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function s3Client(env) {
  if (env.S3_CLIENT) return env.S3_CLIENT;
  if (!env.B2_KEY_ID || !env.B2_APP_KEY) throw new Error("Backblaze credentials are not configured on the Worker.");
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
    service: "s3",
    region: env.B2_REGION || DEFAULT_REGION,
    retries: 2
  });
}
function objectUrl(env, key, query) {
  const endpoint = (env.B2_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/$/, "");
  const bucket = env.B2_BUCKET || DEFAULT_BUCKET;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return endpoint + "/" + encodeURIComponent(bucket) + "/" + encodedKey + (query || "");
}
async function b2Request(env, method, key, options) {
  const opts = options || {};
  const response = await s3Client(env).fetch(objectUrl(env, key, opts.query), {
    method,
    headers: opts.headers || {},
    body: opts.body
  });
  return response;
}
async function assertS3(response, operation) {
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(body);
  throw new Error(operation + " failed (" + response.status + (code ? ", " + code[1] : "") + ").");
}
function xmlValue(xml, name) {
  const match = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(xml);
  return match ? match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
}
async function readCatalog(env) {
  const response = await b2Request(env, "GET", CATALOG_KEY);
  if (response.status === 404) return { videos: [], pending: [] };
  await assertS3(response, "Read catalog");
  try {
    const data = await response.json();
    return {
      videos: Array.isArray(data.videos) ? data.videos : [],
      pending: (Array.isArray(data.pending) ? data.pending : []).filter(
        p => Number(p.created || 0) > Date.now() - 8 * 24 * 60 * 60 * 1000
      )
    };
  } catch (_) {
    throw new Error("Media catalog is damaged. Stop uploads and restore a backup.");
  }
}
async function writeCatalog(env, catalog) {
  const response = await b2Request(env, "PUT", CATALOG_KEY, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(catalog)
  });
  await assertS3(response, "Write catalog");
}
function publicVideo(v) {
  return { id: v.id, title: v.title, category: v.category, size: v.size, modified: v.modified, streamPath: "/media/" + v.id };
}

function phoneStorageOrigin(env) {
  const raw = String(env.PHONE_ORIGIN || env.PHONE_STORAGE_URL || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}

async function readPhoneLibrary(env) {
  const origin = phoneStorageOrigin(env);
  if (!origin) return { online: false, videos: [], storage: null };
  try {
    const catalogResponse = await fetch(origin + "/api/videos", {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!catalogResponse.ok) throw new Error("Phone catalog unavailable");
    const catalog = await catalogResponse.json();
    let storage = catalog.storage || {};
    // Newer phone builds expose a dedicated storage endpoint. Older working
    // builds returned the same media-only figures inside /api/videos.
    try {
      const storageResponse = await fetch(origin + "/api/storage", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      if (storageResponse.ok) storage = await storageResponse.json();
    } catch (_) { /* Use the storage object included in the catalog response. */ }
    const videos = (Array.isArray(catalog.videos) ? catalog.videos : []).map(v => ({
      id: "phone--" + String(v.id || ""),
      title: cleanText(v.title, 120),
      category: cleanText(v.category, 40) || "Uncategorized",
      size: Number(v.size || 0),
      modified: Number(v.modified || 0),
      streamPath: "/media/phone--" + String(v.id || "")
    })).filter(v => /^phone--[A-Za-z0-9._ -]+\.mp4$/i.test(v.id) && Number.isSafeInteger(v.size) && v.size > 0);
    const mediaBytes = Number(storage.mediaBytes ?? storage.usedBytes ?? 0);
    const freeBytes = Number(storage.availableBytes ?? storage.freeBytes ?? 0);
    return {
      online: true,
      videos,
      storage: {
        totalBytes: Number(storage.totalBytes || 0),
        usedBytes: Number(storage.usedBytes || 0),
        freeBytes,
        mediaBytes
      }
    };
  } catch (_) {
    return { online: false, videos: [], storage: null };
  }
}

async function streamPhoneMedia(request, env, filename) {
  const origin = phoneStorageOrigin(env);
  if (!origin || !/^[A-Za-z0-9._ -]+\.mp4$/i.test(filename)) return json({ error: "Phone video unavailable." }, 404);
  const headers = new Headers();
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  const upstream = await fetch(origin + "/media/" + encodeURIComponent(filename), {
    method: request.method,
    headers,
    signal: AbortSignal.timeout(30000)
  });
  const out = {};
  for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  out["Cache-Control"] = "public, max-age=300";
  return respond(request.method === "HEAD" ? null : upstream.body, upstream.status, out);
}
async function streamMedia(request, env, id) {
  const catalog = await readCatalog(env);
  const video = catalog.videos.find(v => v.id === id);
  if (!video) return json({ error: "Video not found." }, 404);
  const headers = {};
  const range = request.headers.get("Range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) {
      return respond(null, 416, { "Content-Range": "bytes */" + video.size, "Accept-Ranges": "bytes" });
    }
    let start = 0;
    let end = video.size - 1;
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) {
        return respond(null, 416, { "Content-Range": "bytes */" + video.size, "Accept-Ranges": "bytes" });
      }
      start = Math.max(0, video.size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), video.size - 1);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= video.size || end < start) {
      return respond(null, 416, { "Content-Range": "bytes */" + video.size, "Accept-Ranges": "bytes" });
    }
    headers.Range = "bytes=" + start + "-" + end;
    const ifRange = request.headers.get("If-Range");
    if (ifRange) headers["If-Range"] = ifRange;
  }
  const upstream = await b2Request(env, request.method, MEDIA_PREFIX + id, { headers });
  if (upstream.status === 404) return json({ error: "Video file is missing." }, 404);
  if (upstream.status !== 200 && upstream.status !== 206) {
    await assertS3(upstream, "Read video");
  }
  const responseHeaders = {
    "Content-Type": upstream.headers.get("Content-Type") || "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff"
  };
  for (const name of ["Content-Length", "Content-Range", "ETag", "Last-Modified"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  return respond(request.method === "HEAD" ? null : upstream.body, upstream.status, responseHeaders);
}
async function initiateMultipart(env, key, title, category) {
  const response = await b2Request(env, "POST", key, {
    query: "?uploads",
    headers: {
      "Content-Type": "video/mp4",
      "Cache-Control": "public, max-age=86400",
      "x-amz-meta-title": title,
      "x-amz-meta-category": category
    }
  });
  await assertS3(response, "Start multipart upload");
  const xml = await response.text();
  const uploadId = xmlValue(xml, "UploadId");
  if (!uploadId || /<Error>/.test(xml)) throw new Error("Backblaze did not return a valid multipart upload ID.");
  return uploadId;
}
async function uploadPart(env, key, uploadId, partNumber, bytes) {
  const query = "?partNumber=" + partNumber + "&uploadId=" + encodeURIComponent(uploadId);
  const response = await b2Request(env, "PUT", key, { query, body: bytes });
  await assertS3(response, "Upload part " + partNumber);
  const etag = response.headers.get("ETag");
  if (!etag) throw new Error("Backblaze did not return an ETag for part " + partNumber + ".");
  return { partNumber, etag };
}
async function completeMultipart(env, key, uploadId, parts) {
  const xml = "<CompleteMultipartUpload>" + parts.map(p =>
    "<Part><PartNumber>" + p.partNumber + "</PartNumber><ETag>" +
    p.etag.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
    "</ETag></Part>"
  ).join("") + "</CompleteMultipartUpload>";
  const response = await b2Request(env, "POST", key, {
    query: "?uploadId=" + encodeURIComponent(uploadId),
    headers: { "Content-Type": "application/xml" },
    body: xml
  });
  await assertS3(response, "Complete multipart upload");
  const body = await response.text();
  if (/<Error>/.test(body)) throw new Error("Backblaze reported an error while completing the upload.");
  return body;
}
async function abortMultipart(env, key, uploadId) {
  const response = await b2Request(env, "DELETE", key, { query: "?uploadId=" + encodeURIComponent(uploadId) });
  await assertS3(response, "Abort multipart upload");
}
async function handleApi(request, env, url) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/health") {
    return json({ ok: true, service: "Anilarper B2 Media", version: 2, maxStorageBytes: MAX_STORAGE_BYTES });
  }
  if (request.method === "GET" && path === "/api/videos") {
    const [catalog, phone] = await Promise.all([readCatalog(env), readPhoneLibrary(env)]);
    const cloudUsedBytes = catalog.videos.reduce((sum, v) => sum + Number(v.size || 0), 0);
    const pendingBytes = catalog.pending.reduce((sum, p) => sum + Number(p.size || 0), 0);
    // Count only Anilarper media as used space. System/apps already occupy
    // part of the phone filesystem, so usable media capacity is media + free.
    const phoneMediaUsed = phone.online ? phone.storage.mediaBytes : 0;
    const phoneFree = phone.online ? phone.storage.freeBytes : 0;
    const phoneMediaCapacity = phoneMediaUsed + phoneFree;
    const cloudVideos = catalog.videos.map(v => ({ ...publicVideo(v), storageLocation: "cloud" }));
    const cloudKeys = new Set(catalog.videos.map(v => String(v.size || 0) + "|" + cleanText(v.title, 120).toLowerCase()));
    const phoneVideos = phone.videos
      .filter(v => !cloudKeys.has(String(v.size) + "|" + v.title.toLowerCase()))
      .map(v => ({ ...v, storageLocation: "phone" }));
    return json({
      videos: [...cloudVideos, ...phoneVideos],
      storage: {
        usedBytes: cloudUsedBytes + phoneMediaUsed,
        pendingBytes,
        maxBytes: MAX_STORAGE_BYTES + phoneMediaCapacity,
        cloud: { usedBytes: cloudUsedBytes, pendingBytes, maxBytes: MAX_STORAGE_BYTES },
        phone: phone.online ? { usedBytes: phoneMediaUsed, mediaBytes: phoneMediaUsed, freeBytes: phoneFree, totalBytes: phoneMediaCapacity, online: true } : { online: false },
        phoneOnline: phone.online
      }
    });
  }
  if (path.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
    let id;
    try { id = decodeURIComponent(path.slice(7)); } catch (_) { return json({ error: "Invalid video ID." }, 404); }
    if (id.startsWith("phone--")) return streamPhoneMedia(request, env, id.slice(7));
    if (!/^[A-Za-z0-9-]+_[A-Za-z0-9._ -]+\.mp4$/i.test(id)) return json({ error: "Invalid video ID." }, 404);
    return streamMedia(request, env, id);
  }
  if (!isAdmin(request, env)) return json({ error: "Admin authorization required." }, 401);

  if (request.method === "POST" && path === "/api/upload/start") {
    const body = await request.json();
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) return json({ error: "File size must be between 1 byte and 5 GiB." }, 400);
    let filename;
    try { filename = safeFilename(body.filename); } catch (e) { return json({ error: e.message }, 400); }
    const catalog = await readCatalog(env);
    const used = catalog.videos.reduce((sum, v) => sum + Number(v.size || 0), 0);
    const reserved = catalog.pending.reduce((sum, p) => sum + Number(p.size || 0), 0);
    if (used + reserved + size > MAX_STORAGE_BYTES) {
      return json({ error: "Storage limit reached. Completed and pending uploads use " + ((used + reserved) / 1e9).toFixed(2) + " GB of 10 GB." }, 413);
    }
    const id = crypto.randomUUID() + "_" + filename;
    const key = MEDIA_PREFIX + id;
    const title = cleanText(body.title, 120) || filename.replace(/\.mp4$/i, "");
    const category = cleanText(body.category, 40) || "Uncategorized";
    const uploadId = await initiateMultipart(env, key, title, category);
    catalog.pending.push({ id, key, uploadId, size, title, category, created: Date.now() });
    try { await writeCatalog(env, catalog); }
    catch (error) { await abortMultipart(env, key, uploadId).catch(() => {}); throw error; }
    return json({ id, uploadId, partSize: PART_SIZE }, 201);
  }

  if (request.method === "PUT" && path === "/api/upload/part") {
    const id = url.searchParams.get("id") || "";
    const uploadId = url.searchParams.get("uploadId") || "";
    const partNumber = Number(url.searchParams.get("partNumber"));
    const catalog = await readCatalog(env);
    const pending = catalog.pending.find(p => p.id === id && p.uploadId === uploadId);
    if (!pending) return json({ error: "Upload session not found." }, 404);
    const length = Number(request.headers.get("Content-Length") || 0);
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000 || !length || length > MAX_PART_BYTES || length > pending.size) {
      return json({ error: "Invalid part number or part size." }, 400);
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== length) return json({ error: "Part length did not match Content-Length." }, 400);
    const part = await uploadPart(env, pending.key, pending.uploadId, partNumber, bytes);
    return json(part);
  }

  if (request.method === "POST" && path === "/api/upload/complete") {
    const body = await request.json();
    const catalog = await readCatalog(env);
    const pending = catalog.pending.find(p => p.id === body.id && p.uploadId === body.uploadId);
    if (!pending) return json({ error: "Upload session not found." }, 404);
    if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > 10000) return json({ error: "Missing multipart parts." }, 400);
    const parts = body.parts.map(p => ({ partNumber: Number(p.partNumber), etag: String(p.etag || "") }));
    if (parts.some((p, i) => !Number.isInteger(p.partNumber) || p.partNumber !== i + 1 || !p.etag)) {
      return json({ error: "Multipart parts must be complete and ordered." }, 400);
    }
    await completeMultipart(env, pending.key, pending.uploadId, parts);
    // A successful CompleteMultipartUpload confirms that B2 assembled the object.
    // Do not require a follow-up HEAD request: some S3-compatible configurations
    // can deny HEAD even when multipart upload and normal GET access are allowed.
    const uploadedSize = Number(pending.size);
    catalog.pending = catalog.pending.filter(p => p.id !== pending.id);
    catalog.videos.push({ id: pending.id, title: pending.title, category: pending.category, size: uploadedSize, modified: Date.now() });
    await writeCatalog(env, catalog);
    return json({ ok: true, video: publicVideo(catalog.videos[catalog.videos.length - 1]) }, 201);
  }

  if (request.method === "POST" && path === "/api/upload/recover") {
    const catalog = await readCatalog(env);
    const stillPending = [];
    const recovered = [];
    const errors = [];
    for (const pending of catalog.pending) {
      try {
        // Verify with a one-byte ranged GET rather than HEAD. This also confirms
        // the object is readable before publishing it in the public catalog.
        const check = await b2Request(env, "GET", pending.key, {
          headers: { Range: "bytes=0-0" }
        });
        if (check.status === 404) {
          stillPending.push(pending);
          continue;
        }
        if (check.status !== 206 && check.status !== 200) {
          await assertS3(check, "Recover stored upload");
        }
        let actualSize = NaN;
        if (check.status === 206) {
          const contentRange = check.headers.get("Content-Range") || "";
          // Parse the total object size from the one-byte ranged GET response.
          const match = /^bytes\s+0-0\/(\d+)$/.exec(contentRange);
          if (match) actualSize = Number(match[1]);
        } else {
          actualSize = Number(check.headers.get("Content-Length"));
        }
        await check.body?.cancel().catch(() => {});
        if (actualSize !== Number(pending.size)) {
          stillPending.push(pending);
          continue;
        }
        recovered.push({
          id: pending.id,
          title: pending.title,
          category: pending.category,
          size: actualSize,
          modified: Date.now()
        });
      } catch (error) {
        stillPending.push(pending);
        errors.push({ id: pending.id, message: String(error && error.message || error).slice(0, 160) });
      }
    }
    if (recovered.length) {
      catalog.pending = stillPending;
      catalog.videos.push(...recovered);
      await writeCatalog(env, catalog);
    }
    return json({ ok: true, recovered: recovered.length, remaining: stillPending.length, errors });
  }

  if (request.method === "POST" && path === "/api/upload/abort") {
    const body = await request.json();
    const catalog = await readCatalog(env);
    const index = catalog.pending.findIndex(p => p.id === body.id && p.uploadId === body.uploadId);
    if (index < 0) return json({ error: "Upload session not found." }, 404);
    const pending = catalog.pending[index];
    await abortMultipart(env, pending.key, pending.uploadId);
    catalog.pending.splice(index, 1);
    await writeCatalog(env, catalog);
    return json({ ok: true });
  }

  const metadataMatch = /^\/api\/videos\/([^/]+)\/metadata$/.exec(path);
  if (request.method === "POST" && metadataMatch) {
    const id = decodeURIComponent(metadataMatch[1]);
    const catalog = await readCatalog(env);
    const video = catalog.videos.find(v => v.id === id);
    if (!video) return json({ error: "Video not found." }, 404);
    const body = await request.json();
    video.title = cleanText(body.title, 120) || video.title;
    video.category = cleanText(body.category, 40) || "Uncategorized";
    await writeCatalog(env, catalog);
    return json({ ok: true, id, title: video.title, category: video.category });
  }

  if (request.method === "DELETE" && path.startsWith("/api/videos/")) {
    const id = decodeURIComponent(path.slice("/api/videos/".length));
    const catalog = await readCatalog(env);
    const index = catalog.videos.findIndex(v => v.id === id);
    if (index < 0) return json({ error: "Video not found." }, 404);
    const deleted = await b2Request(env, "DELETE", MEDIA_PREFIX + id);
    await assertS3(deleted, "Delete video");
    catalog.videos.splice(index, 1);
    await writeCatalog(env, catalog);
    return json({ ok: true, deleted: id });
  }
  return json({ error: "Not found." }, 404);
}
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return respond(null, 204);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" && request.method === "GET") {
        return respond("Anilarper public media API. Open /admin to manage uploads.", 200, { "Content-Type": "text/plain; charset=utf-8" });
      }
      if (url.pathname === "/admin" && request.method === "GET") {
        const asset = await env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), { method: "GET" }));
        const headers = new Headers(asset.headers);
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
        return respond(asset.body, asset.status, headers);
      }
      return await handleApi(request, env, url);
    } catch (error) {
      return json({ error: String(error && error.message || error).slice(0, 240) }, 500);
    }
  }
};
