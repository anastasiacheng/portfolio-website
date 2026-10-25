import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProject, parseTags, safeUrl, validateProject } from "../../js/project-utils.js";

test("parseTags trims, drops empties, and removes case-insensitive duplicates", () => {
    assert.deepEqual(parseTags(" Python, Machine   Learning ,, python, Unity "), ["Python", "Machine Learning", "Unity"]);
    assert.deepEqual(parseTags(""), []);
    assert.deepEqual(parseTags(undefined), []);
});

test("safeUrl accepts http and https links", () => {
    assert.equal(safeUrl("https://github.com/anastasiacheng"), "https://github.com/anastasiacheng");
    assert.equal(safeUrl("  http://example.com  "), "http://example.com/");
});

test("safeUrl rejects script, data, relative, and malformed links", () => {
    for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,hi", "/docs", "github.com", "not a url", ""]) {
        assert.equal(safeUrl(bad), "", bad);
    }
});

test("normalizeProject cleans values and matches the server's field order", () => {
    const project = normalizeProject({
        title: "  Flexle ",
        description: " A word game. ",
        tags: "JS, js, CSS",
        imageFile: "",
        docsUrl: "javascript:alert(1)",
        siteUrl: "https://example.com",
    }, "draft-1");
    assert.deepEqual(project, {
        id: "draft-1",
        title: "Flexle",
        description: "A word game.",
        tags: ["JS", "CSS"],
        image: null,
        docsUrl: "",
        siteUrl: "https://example.com/",
        hidden: false,
    });
    // server/validation.py returns keys in this order; publish status compares them.
    assert.deepEqual(Object.keys(project), ["id", "title", "description", "tags", "image", "docsUrl", "siteUrl", "hidden"]);
});

test("normalizeProject keeps an uploaded image with its alt text", () => {
    const project = normalizeProject({ title: "A", description: "B", imageFile: "abc.webp", imageAlt: " Screenshot " }, "x");
    assert.deepEqual(project.image, { file: "abc.webp", alt: "Screenshot" });
});

test("validateProject requires title and description", () => {
    assert.deepEqual(Object.keys(validateProject({ title: " ", description: "" })).sort(), ["description", "title"]);
    assert.deepEqual(validateProject({ title: "A", description: "B" }), {});
});

test("validateProject enforces the same length limits as the server", () => {
    assert.ok(validateProject({ title: "x".repeat(81), description: "B" }).title);
    assert.ok(validateProject({ title: "A", description: "x".repeat(401) }).description);
    assert.ok(validateProject({ title: "A", description: "B", tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(",") }).tags);
    assert.ok(validateProject({ title: "A", description: "B", tags: "x".repeat(31) }).tags);
});

test("validateProject reports typo'd links instead of silently dropping them", () => {
    const errors = validateProject({ title: "A", description: "B", docsUrl: "github.com/me", siteUrl: "javascript:x" });
    assert.deepEqual(Object.keys(errors).sort(), ["docsUrl", "siteUrl"]);
});

test("validateProject requires alt text when there is an image", () => {
    assert.ok(validateProject({ title: "A", description: "B", imageFile: "a.webp" }).imageAlt);
    assert.deepEqual(validateProject({ title: "A", description: "B", imageFile: "a.webp", imageAlt: "Shot" }), {});
});
