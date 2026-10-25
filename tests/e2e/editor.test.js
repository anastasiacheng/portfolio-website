// Drives the real admin backend and editor in headless Chromium, against temp folders.
// Needs playwright-core: set PLAYWRIGHT_CORE to its folder if it isn't installed here,
// and CHROMIUM_PATH if Playwright can't find its own browser.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const { chromium } = await import(
    process.env.PLAYWRIGHT_CORE ? pathToFileURL(path.join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core"
);

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = 8200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const PASSWORD = "test password";

// 1x1 red PNG, so the test doesn't depend on the gitignored assets folder.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

let tmp, server, browser, page;
const consoleErrors = [];

before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "portfolio-e2e-"));
    mkdirSync(path.join(tmp, "site/assets"), { recursive: true });
    cpSync(path.join(root, "style.css"), path.join(tmp, "site/style.css"));
    writeFileSync(path.join(tmp, "site/assets/AnastasiaChengResume.pdf"), "%PDF-1.4 old %%EOF");
    writeFileSync(path.join(tmp, "password"), PASSWORD + "\n");

    const env = {
        ...process.env,
        PORTFOLIO_PORT: String(port),
        PORTFOLIO_STATE_DIR: path.join(tmp, "state"),
        PORTFOLIO_SITE_DIR: path.join(tmp, "site"),
        PORTFOLIO_PASSWORD_FILE: path.join(tmp, "password"),
        PORTFOLIO_ALLOWED_ORIGINS: base,
        PORTFOLIO_SECURE_COOKIE: "0",   // plain http in tests
        PORTFOLIO_SERVE_SITE: "1",
    };
    // Same first step as deploy/install.sh: build index.html before anything is published.
    execFileSync("python3", ["-m", "server.rebuild"], { cwd: root, env, stdio: "ignore" });
    server = spawn("python3", ["-u", "-m", "server.app"], { cwd: root, env, stdio: ["ignore", "pipe", "inherit"] });
    // Wait for the "listening" line instead of sleeping.
    await new Promise((resolve, reject) => {
        server.stdout.on("data", (chunk) => chunk.toString().includes("listening") && resolve());
        server.on("exit", (code) => reject(new Error(`server exited with code ${code}`)));
    });

    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    page.on("console", (msg) => msg.type() === "error" && consoleErrors.push(msg.text()));
    page.on("pageerror", (err) => consoleErrors.push(err.message));
});

after(async () => {
    if (process.env.SCREENSHOT_DIR) {
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "editor.png"), fullPage: true });
    }
    await browser?.close();
    server?.kill();
    rmSync(tmp, { recursive: true, force: true });
});

// Tag + class outline of an element, e.g. "div.project>[div.project-text>[h3,p],div.project-preview]".
// Repeated tags collapse to one, so cards with different tag counts compare equal.
function outlineOf(el) {
    const walk = (node) => {
        const name = node.tagName.toLowerCase() + (node.className ? "." + node.className : "");
        return node.children.length ? `${name}>[${[...node.children].map(walk).join(",")}]` : name;
    };
    return walk(el).replace(/span\.tag(,span\.tag)+/g, "span.tag");
}

const draftCount = () => page.locator("#draft-list .project").count();
const badges = () => page.locator("#draft-list .editor-badge").allTextContents();
const waitForSave = () => page.waitForFunction(() => !document.querySelector("#save-status").textContent.startsWith("Saving"));
const publicPage = async () => (await fetch(`${base}/`)).text();

async function confirmNext() {
    page.once("dialog", (d) => d.accept());
}

test("the editor requires signing in", async () => {
    await page.goto(`${base}/admin/`);
    assert.match(page.url(), /\/admin\/login$/);

    await page.fill("#username", "abc");
    await page.fill("#password", "wrong");
    await page.click("button[type=submit]");
    assert.equal(await page.textContent(".editor-error"), "Wrong username or password.");

    await page.fill("#username", "abc");
    await page.fill("#password", PASSWORD);
    await page.click("button[type=submit]");
    assert.match(page.url(), /\/admin\/$/);
    await page.waitForSelector("#drafts-empty:not([hidden])");
    assert.match(await page.textContent("#publish-status"), /Nothing published yet/);
});

test("empty submit shows errors and adds nothing", async () => {
    await page.click("#submit-button");
    assert.equal(await page.textContent('[data-error-for="title"]'), "Title is required.");
    assert.equal(await page.textContent('[data-error-for="description"]'), "Description is required.");
    assert.equal(await draftCount(), 0);
});

test("live preview updates as you type and treats HTML as plain text", async () => {
    await page.fill("#title", '<img src=x onerror="window.hacked=1">');
    await page.fill("#description", "A word game.");
    assert.equal(await page.textContent("#live-preview h3"), '<img src=x onerror="window.hacked=1">');
    assert.equal(await page.locator("#live-preview h3 img").count(), 0);
    assert.equal(await page.evaluate(() => window.hacked), undefined);
    assert.equal(await page.textContent('[data-error-for="title"]'), "", "error clears once fixed");
});

test("tags are trimmed and de-duplicated", async () => {
    await page.fill("#tags", "JavaScript, CSS ,, javascript");
    assert.deepEqual(await page.locator("#live-preview .tag").allTextContents(), ["JavaScript", "CSS"]);
});

test("buttons appear only for valid http(s) links", async () => {
    assert.equal(await page.locator("#live-preview .buttons").count(), 0, "no URLs -> no .buttons div");
    await page.fill("#docsUrl", "javascript:alert(1)");
    assert.equal(await page.locator("#live-preview .buttons").count(), 0, "javascript: link is not rendered");
    await page.click("#submit-button");
    assert.match(await page.textContent('[data-error-for="docsUrl"]'), /http/);
    assert.equal(await draftCount(), 0);

    await page.fill("#docsUrl", "https://example.com/docs");
    await page.fill("#siteUrl", "https://example.com");
    assert.deepEqual(await page.locator("#live-preview .buttons a").allTextContents(), ["Documentation", "View Website"]);
});

test("an uploaded image goes through the server and needs alt text", async () => {
    await page.setInputFiles("#imageUpload", { name: "shot.png", mimeType: "image/png", buffer: PNG });
    await page.waitForSelector("#live-preview .project-preview img");
    assert.match(await page.getAttribute("#live-preview .project-preview img", "src"), /^\/admin\/api\/images\/[0-9a-f]{32}\.webp$/);
    assert.ok(await page.evaluate(() => document.querySelector("#live-preview .project-preview img").decode().then(() => true)));

    await page.click("#submit-button");
    assert.match(await page.textContent('[data-error-for="imageAlt"]'), /screen readers/);
    await page.fill("#imageAlt", "Game screenshot");
});

test("a non-image upload is refused with a clear message", async () => {
    await page.setInputFiles("#imageUpload", { name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)>") });
    await page.waitForFunction(() => /Only PNG/.test(document.querySelector("#image-status").textContent));
    assert.equal(await page.locator("#live-preview .project-preview img").count(), 1, "the earlier image is kept");
});

test("added drafts are saved on the server and survive a reload", async () => {
    await page.fill("#title", "Flexle");
    await page.click("#submit-button");
    await waitForSave();
    assert.equal(await draftCount(), 1);
    assert.equal(await page.inputValue("#title"), "", "form resets after saving");

    await page.reload();
    await page.waitForSelector("#draft-list .project");
    assert.equal(await page.textContent("#draft-list h3"), "Flexle");
    assert.deepEqual(await badges(), ["Not live yet"]);
    assert.match(await page.textContent("#publish-status"), /aren't live yet/);
    assert.match(await publicPage(), /coming-soon/, "saving a draft doesn't change the public page");
});

test("publishing puts the card on the home page with the same markup as the editor", async () => {
    await confirmNext();
    await page.click("#publish-button");
    await waitForSave();
    assert.deepEqual(await badges(), ["Live"]);
    assert.ok(await page.isDisabled("#publish-button"), "nothing left to publish");

    const html = await publicPage();
    assert.doesNotMatch(html, /coming-soon/);
    const editorCard = await page.evaluate(`(${outlineOf})(document.querySelector("#draft-list .project"))`);
    const publicCard = await page.evaluate(
        `(${outlineOf})(new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html").querySelector(".project"))`);
    assert.equal(publicCard, editorCard);

    const src = html.match(/assets\/projects\/[0-9a-f]{32}\.webp/)[0];
    assert.equal((await fetch(`${base}/${src}`)).status, 200, "published image is served publicly");
});

test("edits stay drafts until the next publish", async () => {
    await page.click("#draft-list button:has-text('Edit')");
    assert.equal(await page.inputValue("#title"), "Flexle");
    assert.equal(await page.textContent("#submit-button"), "Save changes");
    await page.fill("#title", "Flexle 2");
    await page.click("#submit-button");
    await waitForSave();
    assert.deepEqual(await badges(), ["Live · unpublished edits"]);
    assert.match(await publicPage(), /<h3>Flexle<\/h3>/);
});

test("hidden projects are left out, and restore brings the previous version back", async () => {
    await page.click("#draft-list button:has-text('Hide from site')");
    await waitForSave();
    assert.deepEqual(await badges(), ["Live · will be hidden when you publish"]);
    await confirmNext();
    await page.click("#publish-button");
    await waitForSave();
    assert.match(await publicPage(), /coming-soon/);

    await confirmNext();
    await page.click("#restore-button");
    await waitForSave();
    assert.match(await publicPage(), /<h3>Flexle<\/h3>/);
    assert.equal(await draftCount(), 1, "restore doesn't touch drafts");
});

test("projects can be reordered and deleted", async () => {
    await page.click("#draft-list button:has-text('Show on site')");
    await waitForSave();
    await page.fill("#title", "Second");
    await page.fill("#description", "Another one.");
    await page.click("#submit-button");
    await waitForSave();
    assert.deepEqual(await page.locator("#draft-list h3").allTextContents(), ["Flexle 2", "Second"]);

    await page.locator("#draft-list .editor-draft").nth(1).locator("button:has-text('Move up')").click();
    await waitForSave();
    assert.deepEqual(await page.locator("#draft-list h3").allTextContents(), ["Second", "Flexle 2"]);

    await confirmNext();
    await page.locator("#draft-list .editor-draft").nth(0).locator("button:has-text('Delete')").click();
    await waitForSave();
    assert.deepEqual(await page.locator("#draft-list h3").allTextContents(), ["Flexle 2"]);
});

test("replacing the resume updates the file and the home page link", async () => {
    await page.setInputFiles("#resumeFile", { name: "resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 new %%EOF\n") });
    await confirmNext();
    await page.click("#resume-form button[type=submit]");
    await waitForSave();
    assert.match(await page.textContent("#save-status"), /Resume replaced/);
    assert.equal(readFileSync(path.join(tmp, "site/assets/AnastasiaChengResume.pdf"), "utf8"), "%PDF-1.7 new %%EOF\n");
    assert.match(await publicPage(), /AnastasiaChengResume\.pdf\?v=3/);
    assert.match(await page.getAttribute("#resume-link", "href"), /\?v=3$/);
});

test("preview links open in a new tab instead of leaving the editor", async () => {
    const [popup] = await Promise.all([
        page.context().waitForEvent("page"),
        page.click("#draft-list .buttons a:has-text('Documentation')"),
    ]);
    await popup.close();
    assert.match(page.url(), /\/admin\/$/);
});

test("the home page has the admin link", async () => {
    assert.match(await publicPage(), /<a class="admin-link" href="\/admin\/"/);
});

test("the home page fits common phone widths with nothing cut off on either side", async () => {
    for (const width of [320, 360, 412]) {
        const phone = await browser.newPage({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
        await phone.goto(`${base}/`, { waitUntil: "networkidle" });
        const offscreen = await phone.evaluate(() => {
            const vw = document.documentElement.clientWidth;
            return [...document.querySelectorAll("body *")]
                .map((el) => [el, el.getBoundingClientRect()])
                .filter(([, r]) => r.width && (r.left < -0.5 || r.right > vw + 0.5))
                .map(([el, r]) => `${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
        });
        await phone.close();
        assert.deepEqual(offscreen, [], `at ${width}px`);
    }
});

test("logging out ends the session", async () => {
    await page.click("text=Log out");
    assert.match(page.url(), /\/admin\/login$/);
    assert.equal((await page.request.get(`${base}/admin/api/state`)).status(), 401);
});

test("no errors or content-security-policy violations were logged", () => {
    // The intentional 400 from the bad upload above shows up as a failed-resource console error.
    const unexpected = consoleErrors.filter((e) => !/fonts\.(googleapis|gstatic)/.test(e) && !/status of 400/.test(e));
    assert.deepEqual(unexpected, []);
});
