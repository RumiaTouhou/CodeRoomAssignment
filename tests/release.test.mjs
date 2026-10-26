import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const soundHashes = {
  "EnterRoom.wav": "1cf15b01b3480309c6e469ffe1aa80f1aa36b3b34de3535260190e0fb7c9b722",
  "LeaveRoom.wav": "39c316873d216b38a33e47de98593a35279849a423f960c49662ca9a76c5f307",
  "MyMsgSent.wav": "3af00e5bc936626bb52cc14b472ca726269a30ab5a6d44d482437fc0611c233f",
  "NewMsg.wav": "c40a1c57b3d73c75e1a508884bee3ce472508a7f9a6af60db8ac6eec7d0c1da3",
};

function file(path) {
  const absolute = resolve(root, path);
  assert.ok(existsSync(absolute), `${path} is required; run npm run build before release checks`);
  assert.ok(statSync(absolute).isFile(), `${path} must be a regular file`);
  return readFileSync(absolute);
}

function text(path) { return file(path).toString("utf8"); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function filesIn(directory, excluded = new Set()) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return excluded.has(entry.name) ? [] : filesIn(path, excluded);
    return entry.isFile() ? [path] : [];
  });
}

function productionAssets() {
  const html = text("client/dist/index.html");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)].map(match => match[1]);
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1, "the production page must load one application entry");
  assert.ok(styles.some(path => path.startsWith("/assets/")), "the production page must load bundled styles");
  const paths = [...scripts, ...styles.filter(path => path.startsWith("/assets/"))];
  for (const path of paths) {
    assert.match(path, /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/, "assets must use local build paths");
    assert.ok(file(`client/dist${path}`).byteLength > 0, `${path} must contain data`);
  }
  return { html, paths };
}

test("production assets load the application rather than the component showcase", () => {
  const { html, paths } = productionAssets();
  assert.match(html, /<title>CodeRoom<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.doesNotMatch(html, /\/src\/|preview\.html|ui-preview/);
  const entry = text("client/src/main.tsx");
  assert.match(entry, /import\s*\{\s*Application\s*\}\s*from\s*["']\.\/app\/Application\.js["']/);
  assert.doesNotMatch(entry, /\/preview\/|PreviewHost|MockCallbacks|EnglishMockScenarios/);
  const built = paths.filter(path => path.endsWith(".js")).map(path => text(`client/dist${path}`)).join("\n");
  assert.match(built, /\/api\/sessions/);
  assert.match(built, /\/api\/rooms\/lobby\/search/);
  assert.match(built, /room\.snapshot/);
  for (const name of ["NewMsg.wav", "EnterRoom.wav", "LeaveRoom.wav"]) {
    assert.ok(built.includes(`/sounds/${name}`), `${name} must be referenced by the application`);
  }
  assert.doesNotMatch(built, /PreviewHost|EnglishMockScenarios|MockCallbacks|Mock UI Preview|Preview scenario|preview intent only/);
  const files = filesIn(resolve(root, "client/dist")).map(path => relative(resolve(root, "client/dist"), path));
  assert.ok(files.every(path => !/(?:^|\/)preview\.html$|\.map$|\.(?:tsx?|md)$/i.test(path)), "production assets must not include source or showcase files");
  for (const path of ["dist/server/index.js", "dist/server/app.js", "dist/server/database.js", "dist/shared/validation.js", "dist/shared/limits.js"]) file(path);
});

test("bundled sounds retain their original bytes in source and production", () => {
  for (const [name, expected] of Object.entries(soundHashes)) {
    for (const directory of ["client/public/sounds", "client/dist/sounds"]) {
      const bytes = file(`${directory}/${name}`);
      assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
      assert.equal(hash(bytes), expected, `${directory}/${name} must retain the original WAV`);
    }
  }
});

test("the emitted server serves production assets with the security policy", async () => {
  file("dist/server/app.js");
  const { createChatServer } = await import("../dist/server/app.js");
  const application = createChatServer({ staticDir: resolve(root, "client/dist") });
  try {
    const { origin } = await application.listen();
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, protocolVersion: 1 });
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), text("client/dist/index.html"));
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /(?:^|;)\s*script-src 'self'(?:;|$)/);
    assert.match(policy, /(?:^|;)\s*frame-ancestors 'none'(?:;|$)/);
    assert.match(policy, /(?:^|;)\s*object-src 'none'(?:;|$)/);
    assert.doesNotMatch(policy, /'unsafe-eval'/);
    for (const path of productionAssets().paths) {
      const asset = await fetch(`${origin}${path}`);
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get("content-type") ?? "", path.endsWith(".js") ? /^text\/javascript/ : /^text\/css/);
      assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.equal(hash(Buffer.from(await asset.arrayBuffer())), hash(file(`client/dist${path}`)));
    }
    for (const [name, expected] of Object.entries(soundHashes)) {
      const sound = await fetch(`${origin}/sounds/${name}`);
      assert.equal(sound.status, 200);
      assert.match(sound.headers.get("content-type") ?? "", /^audio\/wav/);
      assert.equal(hash(Buffer.from(await sound.arrayBuffer())), expected);
    }
    for (const path of ["/preview.html", "/src/main.tsx", "/server/app.ts", "/package.json"]) {
      const unavailable = await fetch(`${origin}${path}`);
      assert.equal(unavailable.status, 404, `${path} must not be publicly served`);
      await unavailable.arrayBuffer();
    }
    const method = await fetch(origin, { method: "POST" });
    assert.equal(method.status, 404);
    await method.arrayBuffer();
  } finally { await application.close(); }
});

test("the workspace lockfile uses public registry artifacts and matches both manifests", () => {
  const lock = JSON.parse(text("package-lock.json"));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, JSON.parse(text("package.json")).name);
  for (const [key, manifestPath] of [["", "package.json"], ["client", "client/package.json"]]) {
    const manifest = JSON.parse(text(manifestPath));
    const locked = lock.packages[key];
    assert.ok(locked, `${key || "root"} must be represented in the workspace lockfile`);
    for (const field of ["name", "dependencies", "devDependencies", "workspaces", "engines"]) {
      assert.deepEqual(locked[field], manifest[field], `${manifestPath} ${field} must match the lockfile`);
    }
  }
  let artifacts = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "" || path === "client") continue;
    if (entry.link) { assert.equal(entry.resolved, "client"); continue; }
    const url = new URL(entry.resolved);
    assert.equal(url.protocol, "https:", path);
    assert.equal(url.hostname, "registry.npmjs.org", path);
    assert.equal(url.username + url.password, "", path);
    assert.equal(url.search + url.hash, "", path);
    assert.match(entry.integrity ?? "", /^sha512-[A-Za-z0-9+/]+=*$/, `${path} must have an integrity digest`);
    artifacts += 1;
  }
  assert.ok(artifacts > 0, "the lockfile must pin registry artifacts");
  assert.ok(!existsSync(resolve(root, "client/package-lock.json")), "the workspace must have one root lockfile");
});

test("the container runs the emitted application as an unprivileged user", () => {
  const docker = text("Dockerfile");
  const runtime = docker.split(/^FROM\s+/m).at(-1) ?? "";
  assert.match(runtime, /node:22-alpine/);
  assert.match(runtime, /^RUN npm ci --omit=dev\b/m);
  assert.match(runtime, /^COPY --from=build \/app\/dist \.\/dist$/m);
  assert.match(runtime, /^COPY --from=build \/app\/client\/dist \.\/client\/dist$/m);
  assert.match(runtime, /^RUN mkdir -p \/app\/data && chown node:node \/app\/data$/m);
  assert.match(runtime, /^VOLUME \["\/app\/data"\]$/m);
  assert.match(runtime, /^USER node$/m);
  assert.doesNotMatch(runtime, /^USER (?:root|0)$/m);
  assert.match(runtime, /^CMD \["node", "dist\/server\/index\.js"\]$/m);
  assert.match(runtime, /^HEALTHCHECK\b/m);
  assert.equal(JSON.parse(text("package.json")).scripts.start, "node dist/server/index.js");
});

test("the package includes only the product readme as documentation", () => {
  const readme = text("README.md");
  assert.match(readme, /^# CodeRoom\b/);
  for (const command of ["npm ci", "npm run dev", "npm run build", "npm start", "npm run test:browser", "npm.cmd ci", "npm.cmd run dev", "npm.cmd start"]) {
    assert.ok(readme.includes(command), `${command} must be documented`);
  }
  for (const setting of ["ADMIN_PASSWORD", "DATA_FILE", "ALLOWED_ORIGINS"]) assert.ok(readme.includes(setting), `${setting} must be documented`);
  assert.match(readme, /22\.13 or later/);
  assert.match(readme, /SQLite/);
  assert.match(readme, /Use saved guest identity/);
  const excluded = new Set(["node_modules", ".git", "dist", "dist-preview", ".browser-results", ".test-cache", "coverage"]);
  const documents = filesIn(root, excluded).filter(path => /\.(?:md|mdx|rst|txt)$/i.test(path)).map(path => relative(root, path));
  assert.deepEqual(documents.sort(), ["README.md"]);
});
