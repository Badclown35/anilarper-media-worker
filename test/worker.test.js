import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

class MemoryS3 {
  constructor() {
    this.objects = new Map();
    this.sessions = new Map();
    this.denyHead = false;
  }
  async fetch(input, init = {}) {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ""));
    const query = url.searchParams;
    const method = init.method || "GET";
    if (method === "POST" && url.search === "?uploads") {
      const uploadId = "upload-" + (this.sessions.size + 1);
      this.sessions.set(uploadId, { key: path, parts: new Map() });
      return new Response("<InitiateMultipartUploadResult><UploadId>" + uploadId + "</UploadId></InitiateMultipartUploadResult>", { status: 200 });
    }
    if (query.has("partNumber") && method === "PUT") {
      const session = this.sessions.get(query.get("uploadId"));
      if (!session || session.key !== path) return new Response("missing", { status: 404 });
      const number = Number(query.get("partNumber"));
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      session.parts.set(number, bytes);
      return new Response(null, { status: 200, headers: { ETag: '"etag-' + number + '"' } });
    }
    if (query.has("uploadId") && method === "POST") {
      const uploadId = query.get("uploadId");
      const session = this.sessions.get(uploadId);
      if (!session || session.key !== path) return new Response("missing", { status: 404 });
      const xml = String(init.body || "");
      const numbers = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(m => Number(m[1]));
      const chunks = numbers.map(n => session.parts.get(n));
      if (chunks.some(x => !x)) return new Response("missing part", { status: 400 });
      this.objects.set(path, new Uint8Array(await new Blob(chunks).arrayBuffer()));
      this.sessions.delete(uploadId);
      return new Response("<CompleteMultipartUploadResult/>", { status: 200 });
    }
    if (query.has("uploadId") && method === "DELETE") {
      this.sessions.delete(query.get("uploadId"));
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      this.objects.set(path, new Uint8Array(await new Response(init.body).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      this.objects.delete(path);
      return new Response(null, { status: 204 });
    }
    const bytes = this.objects.get(path);
    if (!bytes) return new Response("not found", { status: 404 });
    if (method === "HEAD" && this.denyHead) return new Response("forbidden", { status: 403 });
    const headers = new Headers({
      "Content-Length": String(bytes.length),
      "Content-Type": path.endsWith(".json") ? "application/json" : "video/mp4",
      "ETag": '"memory-etag"'
    });
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    const range = new Headers(init.headers || {}).get("Range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416 });
      const start = Number(match[1] || 0);
      const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      const selected = bytes.slice(start, end + 1);
      headers.set("Content-Length", String(selected.length));
      headers.set("Content-Range", "bytes " + start + "-" + end + "/" + bytes.length);
      return new Response(selected, { status: 206, headers });
    }
    return new Response(bytes, { status: 200, headers });
  }
}
function request(path, options = {}) {
  return new Request("https://anilarper.test" + path, options);
}
function env() {
  return {
    S3_CLIENT: new MemoryS3(),
    ADMIN_TOKEN: "test-admin-token",
    ASSETS: { async fetch() { return new Response("admin"); } }
  };
}
const adminHeaders = { Authorization: "Bearer test-admin-token" };

test("admin page is served with protective response headers", async () => {
  const e = env();
  const admin = await worker.fetch(request("/admin"), e);
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get("Cache-Control"), "no-store");
  assert.match(admin.headers.get("Content-Security-Policy"), /default-src 'self'/);
});

test("health and public catalog are available without admin credentials", async () => {
  const e = env();
  const health = await worker.fetch(request("/api/health"), e);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "Anilarper B2 Media");
  const catalog = await worker.fetch(request("/api/videos"), e);
  assert.deepEqual((await catalog.json()).videos, []);
});

test("uploads require admin auth and public media supports byte ranges without relying on HEAD", async () => {
  const e = env();
  e.S3_CLIENT.denyHead = true;
  const denied = await worker.fetch(request("/api/upload/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "clip.mp4", size: 3 })
  }), e);
  assert.equal(denied.status, 401);

  const started = await worker.fetch(request("/api/upload/start", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "clip.mp4", title: "Test Clip", category: "Clips", size: 3 })
  }), e);
  assert.equal(started.status, 201);
  const session = await started.json();

  const part = await worker.fetch(request("/api/upload/part?id=" + encodeURIComponent(session.id) +
    "&uploadId=" + encodeURIComponent(session.uploadId) + "&partNumber=1", {
      method: "PUT",
      headers: { ...adminHeaders, "Content-Length": "3" },
      body: new Uint8Array([65, 66, 67])
    }), e);
  assert.equal(part.status, 200);
  const partData = await part.json();

  const completed = await worker.fetch(request("/api/upload/complete", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ id: session.id, uploadId: session.uploadId, parts: [partData] })
  }), e);
  assert.equal(completed.status, 201);

  const catalog = await worker.fetch(request("/api/videos"), e);
  const video = (await catalog.json()).videos[0];
  assert.equal(video.title, "Test Clip");
  assert.equal(video.size, 3);

  const range = await worker.fetch(request(video.streamPath, { headers: { Range: "bytes=1-2" } }), e);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("Content-Range"), "bytes 1-2/3");
  assert.equal(await range.text(), "BC");
});

test("admin can recover completed stored uploads when HEAD is denied", async () => {
  const e = env();
  e.S3_CLIENT.denyHead = true;
  await e.S3_CLIENT.fetch("https://s3.test/bucket/media/recovered_clip.mp4", {
    method: "PUT",
    body: new Uint8Array([65, 66, 67])
  });
  await e.S3_CLIENT.fetch("https://s3.test/bucket/_anilarper/catalog.json", {
    method: "PUT",
    body: JSON.stringify({
      videos: [],
      pending: [{
        id: "recovered_clip.mp4",
        key: "media/recovered_clip.mp4",
        uploadId: "already-completed",
        size: 3,
        title: "Recovered Clip",
        category: "Anime",
        created: Date.now()
      }]
    })
  });
  const recovered = await worker.fetch(request("/api/upload/recover", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: "{}"
  }), e);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).recovered, 1);
  const catalog = await worker.fetch(request("/api/videos"), e);
  const data = await catalog.json();
  assert.equal(data.videos.length, 1);
  assert.equal(data.videos[0].title, "Recovered Clip");
  assert.equal(data.storage.pendingBytes, 0);
});

test("storage cap rejects new uploads and admin can edit/delete", async () => {
  const e = env();
  await e.S3_CLIENT.fetch("https://s3.test/bucket/_anilarper/catalog.json", {
    method: "PUT",
    body: JSON.stringify({
      videos: [{ id: "old.mp4", size: 10_000_000_000, title: "Old", category: "Anime" }],
      pending: []
    })
  });
  const full = await worker.fetch(request("/api/upload/start", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "next.mp4", size: 1 })
  }), e);
  assert.equal(full.status, 413);

  await e.S3_CLIENT.fetch("https://s3.test/bucket/media/sample.mp4", {
    method: "PUT",
    body: new Uint8Array([1, 2, 3])
  });
  await e.S3_CLIENT.fetch("https://s3.test/bucket/_anilarper/catalog.json", {
    method: "PUT",
    body: JSON.stringify({
      videos: [{ id: "sample.mp4", size: 3, title: "Before", category: "Anime" }],
      pending: []
    })
  });
  const edit = await worker.fetch(request("/api/videos/sample.mp4/metadata", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "After", category: "Clips" })
  }), e);
  assert.equal(edit.status, 200);
  const del = await worker.fetch(request("/api/videos/sample.mp4", {
    method: "DELETE",
    headers: adminHeaders
  }), e);
  assert.equal(del.status, 200);
  assert.equal((await (await worker.fetch(request("/api/videos"), e)).json()).videos.length, 0);
});


test("phone storage joins the community catalog and streams byte ranges", async () => {
  const e = env();
  await e.S3_CLIENT.fetch("https://s3.test/bucket/_anilarper/catalog.json", {
    method: "PUT",
    body: JSON.stringify({
      videos: [{ id: "cloud_copy.mp4", size: 5, title: "Shared Episode", category: "Anime" }],
      pending: []
    })
  });
  e.PHONE_ORIGIN = "https://phone.test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/api/videos") {
      return Response.json({ videos: [
        { id: "shared.mp4", title: "Shared Episode", category: "Anime", size: 5 },
        { id: "phone-only.mp4", title: "Phone Only", category: "Anime", size: 6 }
      ] });
    }
    if (url.pathname === "/api/storage") {
      return Response.json({ totalBytes: 10000, usedBytes: 9000, freeBytes: 900, mediaBytes: 100 });
    }
    if (url.pathname === "/media/phone-only.mp4") {
      assert.equal(init.headers.get("Range"), "bytes=1-3");
      return new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "3",
          "Content-Range": "bytes 1-3/6",
          "Accept-Ranges": "bytes"
        }
      });
    }
    throw new Error("Unexpected phone request: " + url.pathname);
  };
  try {
    const response = await worker.fetch(request("/api/videos"), e);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.videos.length, 2);
    assert.equal(data.videos.filter(v => v.title === "Shared Episode").length, 1);
    assert.equal(data.videos.find(v => v.title === "Phone Only").storageLocation, "phone");
    assert.equal(data.storage.usedBytes, 105);
    assert.equal(data.storage.maxBytes, 10_000_000_000 + 1_000);
    assert.equal(data.storage.phone.online, true);

    const streamed = await worker.fetch(request("/media/phone--phone-only.mp4", {
      headers: { Range: "bytes=1-3" }
    }), e);
    assert.equal(streamed.status, 206);
    assert.equal(streamed.headers.get("Content-Range"), "bytes 1-3/6");
    assert.deepEqual([...new Uint8Array(await streamed.arrayBuffer())], [2, 3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("original PHONE_STORAGE_URL tunnel and embedded media-only storage remain compatible", async () => {
  const e = env();
  e.PHONE_STORAGE_URL = "https://original-phone-tunnel.example";
  e.PHONE_ORIGIN = "https://stale-phone-origin.example";
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(input);
    assert.equal(url.origin, "https://original-phone-tunnel.example");
    calls.push(url.pathname);
    if (url.pathname === "/api/videos") {
      return Response.json({
        videos: [{ id: "original.mp4", title: "Original Phone Video", category: "Anime", size: 12 }],
        storage: { usedBytes: 12, pendingBytes: 3, availableBytes: 988, maxBytes: 1003 }
      });
    }
    if (url.pathname === "/api/storage") return new Response("not found", { status: 404 });
    if (url.pathname === "/media/original.mp4") {
      return new Response(new Uint8Array([7, 8]), {
        status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Length": "2",
          "Content-Range": "bytes 1-2/12", "Accept-Ranges": "bytes" }
      });
    }
    throw new Error("Unexpected original phone request: " + url.pathname);
  };
  try {
    const response = await worker.fetch(request("/api/videos"), e);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.storage.phone.online, true);
    assert.equal(data.videos[0].id, "phone--original.mp4");
    assert.equal(data.storage.phone.usedBytes, 12);
    assert.equal(data.storage.phone.pendingBytes, 3);
    assert.equal(data.storage.phone.totalBytes, 1003);
    assert.equal(data.storage.pendingBytes, 3);
    assert.ok(calls.includes("/api/storage"));

    const streamed = await worker.fetch(request("/media/phone--original.mp4", {
      headers: { Range: "bytes=1-2" }
    }), e);
    assert.equal(streamed.status, 206);
    assert.equal(streamed.headers.get("Content-Range"), "bytes 1-2/12");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
