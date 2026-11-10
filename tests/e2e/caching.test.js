// A returning visitor must see a newly published page and resume without a hard refresh.
// Runs a throwaway Caddy built from deploy/portfolio.caddy, so it tests the real cache rules.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const { chromium } = await import(
    process.env.PLAYWRIGHT_CORE ? pathToFileURL(path.join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core"
);

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = 8800 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const MONTH_AGO = new Date(Date.now() - 30 * 24 * 3600 * 1000);

let tmp, caddy, browser, context;

// Files last changed about a month ago, like the live site between edits. Without explicit
// cache rules a browser may then reuse its saved copy for days without asking the server.
// Each write gets a later time, as a real upload does; Caddy's ETag is based on size and time.
let writes = 0;
function writeOld(name, content) {
    const file = path.join(tmp, "site", name);
    const when = new Date(MONTH_AGO.getTime() + ++writes * 60 * 1000);
    writeFileSync(file, content);
    utimesSync(file, when, when);
}

const page = (version) => `<!DOCTYPE html><a id="resume" href="assets/AnastasiaChengResume.pdf?v=${version}">View Resume</a>`;

before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "portfolio-cache-"));
    mkdirSync(path.join(tmp, "site/assets"), { recursive: true });
    writeOld("index.html", page(2));
    writeOld("assets/AnastasiaChengResume.pdf", "%PDF-1.4 old resume %%EOF");

    // The real site block, pointed at a temp folder and a local port.
    const site = readFileSync(path.join(root, "deploy/portfolio.caddy"), "utf8")
        .replace(/^anastasiacheng\.com.*\{$/m, `http://127.0.0.1:${port} {`)
        .replaceAll("/var/www/mywebsite", path.join(tmp, "site"));
    writeFileSync(path.join(tmp, "Caddyfile"), `{\n\tadmin off\n\tpersist_config off\n}\n${site}`);

    caddy = spawn("caddy", ["run", "--config", path.join(tmp, "Caddyfile"), "--adapter", "caddyfile"], { stdio: ["ignore", "ignore", "pipe"] });
    await new Promise((resolve, reject) => {
        caddy.stderr.on("data", (chunk) => chunk.toString().includes("serving initial configuration") && resolve());
        caddy.on("exit", (code) => reject(new Error(`caddy exited with code ${code}`)));
    });
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    context = await browser.newContext();   // one browser profile = one returning visitor
});

after(async () => {
    await browser?.close();
    caddy?.kill();
    rmSync(tmp, { recursive: true, force: true });
});

test("a returning visitor gets the new home page and resume after an upload", async () => {
    const tab = await context.newPage();
    await tab.goto(`${base}/`);
    assert.match(await tab.getAttribute("#resume", "href"), /v=2$/);
    const first = await context.request.get(`${base}/assets/AnastasiaChengResume.pdf`);
    assert.match(await first.text(), /old resume/);

    // What the admin does on a resume upload: new PDF, page re-rendered with a new ?v=.
    writeOld("index.html", page(3));
    writeOld("assets/AnastasiaChengResume.pdf", "%PDF-1.4 new resume %%EOF");

    await tab.goto(`${base}/`);   // a normal visit, not a hard refresh
    assert.match(await tab.getAttribute("#resume", "href"), /v=3$/, "home page came from a stale browser cache");
    const pdf = await tab.evaluate(async () => (await fetch("assets/AnastasiaChengResume.pdf")).text());
    assert.match(pdf, /new resume/, "unversioned resume link came from a stale browser cache");
});

test("pages and the resume must be re-checked; nothing else is affected", async () => {
    for (const p of ["/", "/index.html", "/assets/AnastasiaChengResume.pdf"]) {
        const res = await fetch(base + p);
        assert.equal(res.headers.get("cache-control"), "no-cache", p);
        assert.ok(res.headers.get("etag"), `${p} has an ETag, so re-checks are cheap 304s`);
    }
    const res = await fetch(`${base}/missing.css`);
    assert.equal(res.headers.get("cache-control"), null);
});
