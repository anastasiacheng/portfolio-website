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

test("normalizeProject cleans values and drops unusable URLs", () => {
    const project = normalizeProject({
        title: "  Flexle ",
        description: " A word game. ",
        tags: "JS, js, CSS",
        imageSrc: "",
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
    });
});

test("normalizeProject keeps an image with its alt text", () => {
    const project = normalizeProject({ title: "A", description: "B", imageSrc: "blob:abc", imageAlt: " Screenshot " }, "x");
    assert.deepEqual(project.image, { src: "blob:abc", alt: "Screenshot" });
});

test("validateProject requires title and description", () => {
    assert.deepEqual(Object.keys(validateProject({ title: " ", description: "" })).sort(), ["description", "title"]);
    assert.deepEqual(validateProject({ title: "A", description: "B" }), {});
});

test("validateProject reports typo'd links instead of silently dropping them", () => {
    const errors = validateProject({ title: "A", description: "B", docsUrl: "github.com/me", siteUrl: "javascript:x", imageUrl: "pic.png" });
    assert.deepEqual(Object.keys(errors).sort(), ["docsUrl", "imageUrl", "siteUrl"]);
});

test("validateProject requires alt text when there is an image", () => {
    assert.ok(validateProject({ title: "A", description: "B", imageSrc: "blob:x" }).imageAlt);
    assert.deepEqual(validateProject({ title: "A", description: "B", imageSrc: "blob:x", imageAlt: "Shot" }), {});
});
