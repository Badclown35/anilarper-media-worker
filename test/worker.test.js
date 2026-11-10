import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

class MemoryS3 {
  constructor() {
    this.objects = new Map();
    this.sessions = new Map();
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

test("uploads require admin auth and public media supports byte ranges", async () => {
  const e = env();
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
