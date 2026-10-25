// Drives admin/editor.html in headless Chromium.
// Needs playwright-core: set PLAYWRIGHT_CORE to its folder if it isn't installed here,
// and CHROMIUM_PATH if Playwright can't find its own browser.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const { chromium } = await import(
    process.env.PLAYWRIGHT_CORE ? pathToFileURL(path.join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core"
);

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = 8200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;

// 1x1 red PNG, so the test doesn't depend on the gitignored assets folder.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

let server, browser, page;
const consoleErrors = [];
const nonGetRequests = [];

before(async () => {
    // -u (unbuffered) so the "Serving HTTP" line arrives as soon as the server is listening.
    server = spawn("python3", ["-u", "-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((resolve, reject) => {
        server.stdout.on("data", (chunk) => chunk.toString().includes("Serving HTTP") && resolve());
        server.on("exit", (code) => reject(new Error(`http.server exited with code ${code}`)));
    });
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    page.on("console", (msg) => msg.type() === "error" && consoleErrors.push(msg.text()));
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("request", (req) => req.method() !== "GET" && nonGetRequests.push(`${req.method()} ${req.url()}`));
    await page.goto(`${base}/admin/editor.html`);
});

after(async () => {
    if (process.env.SCREENSHOT_DIR) {
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "editor.png"), fullPage: true });
    }
    await browser?.close();
    server?.kill();
});

// Tag + class outline of a card, e.g. "div.project>[div.project-text>[h3,p,...],div.project-preview]"
const outline = (selector) => page.evaluate((sel) => {
    const walk = (el) => {
        const name = el.tagName.toLowerCase() + (el.className ? "." + el.className : "");
        return el.children.length ? `${name}>[${[...el.children].map(walk).join(",")}]` : name;
    };
    return walk(document.querySelector(sel));
}, selector);

const draftCount = () => page.locator("#draft-list .project").count();

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
    assert.deepEqual(await page.locator("#live-preview .buttons a").allTextContents(), ["Documentation"]);
    await page.fill("#siteUrl", "https://example.com");
    assert.deepEqual(await page.locator("#live-preview .buttons a").allTextContents(), ["Documentation", "View Website"]);
});

test("an uploaded image shows in the preview and needs alt text", async () => {
    await page.setInputFiles("#imageFile", { name: "shot.png", mimeType: "image/png", buffer: PNG });
    const src = await page.getAttribute("#live-preview .project-preview img", "src");
    assert.match(src, /^blob:/);
    assert.ok(await page.evaluate(() => document.querySelector("#live-preview .project-preview img").decode().then(() => true)));

    await page.click("#submit-button");
    assert.match(await page.textContent('[data-error-for="imageAlt"]'), /screen readers/);
    await page.fill("#imageAlt", "Game screenshot");
});

test("adding a draft resets the form and renders the same markup as index.html", async () => {
    await page.fill("#title", "Flexle");
    await page.click("#submit-button");
    assert.equal(await draftCount(), 1);
    assert.equal(await page.inputValue("#title"), "");

    const draft = await outline("#draft-list .project");
    const live = await page.evaluate(async () => {
        const html = await (await fetch("../index.html")).text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const walk = (el) => {
            const name = el.tagName.toLowerCase() + (el.className ? "." + el.className : "");
            return el.children.length ? `${name}>[${[...el.children].map(walk).join(",")}]` : name;
        };
        return walk(doc.querySelector(".project"));
    });
    // Compare structure, not tag count: index.html's placeholder has 3 tags, this draft has 2.
    const oneTag = (s) => s.replace(/span\.tag(,span\.tag)+/g, "span.tag");
    // index.html's placeholder card has an empty preview box; ours holds the image.
    assert.equal(oneTag(draft), oneTag(live).replace("div.project-preview", "div.project-preview>[img]"));
});

test("editing a draft updates it in place and keeps its image", async () => {
    await page.click("#draft-list .editor-draft button:has-text('Edit')");
    assert.equal(await page.inputValue("#title"), "Flexle");
    assert.equal(await page.textContent("#submit-button"), "Save changes");
    await page.fill("#title", "Flexle 2");
    await page.click("#submit-button");
    assert.equal(await draftCount(), 1);
    assert.equal(await page.textContent("#draft-list .project h3"), "Flexle 2");
    assert.ok(await page.evaluate(() => document.querySelector("#draft-list .project-preview img").decode().then(() => true)),
        "blob image still loads after editing");
});

test("drafts can be reordered and deleted", async () => {
    await page.fill("#title", "Second");
    await page.fill("#description", "Another one.");
    await page.click("#submit-button");
    assert.deepEqual(await page.locator("#draft-list h3").allTextContents(), ["Flexle 2", "Second"]);

    await page.locator("#draft-list .editor-draft").nth(1).locator("button:has-text('Move up')").click();
    assert.deepEqual(await page.locator("#draft-list h3").allTextContents(), ["Second", "Flexle 2"]);

    page.once("dialog", (d) => d.accept());
    await page.locator("#draft-list .editor-draft").nth(0).locator("button:has-text('Delete')").click();
    assert.deepEqual(await page.locator("#draft-list h3").allTextContents(), ["Flexle 2"]);
});

test("preview links open in a new tab instead of leaving the editor", async () => {
    const [popup] = await Promise.all([
        page.context().waitForEvent("page"),
        page.click("#draft-list .buttons a:has-text('Documentation')"),
    ]);
    await popup.close();
    assert.match(page.url(), /admin\/editor\.html$/);
    assert.equal(await draftCount(), 1, "drafts survive the click");
});

test("nothing was sent anywhere and no errors were logged", () => {
    assert.deepEqual(nonGetRequests, []);
    assert.deepEqual(consoleErrors.filter((e) => !/fonts\.(googleapis|gstatic)/.test(e)), []);
});
