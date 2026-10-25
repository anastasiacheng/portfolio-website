// Pure helpers for project data. No DOM access, so they run in Node tests too.
// server/validation.py enforces the same rules; keep LIMITS in sync with it.

export const LIMITS = { title: 80, description: 400, tag: 30, tags: 10, alt: 150, url: 500 };

// "Python, ML , python,, Unity" -> ["Python", "ML", "Unity"]
export function parseTags(input) {
    const seen = new Set();
    const tags = [];
    for (const raw of String(input ?? "").split(",")) {
        const tag = raw.trim().replace(/\s+/g, " ");
        const key = tag.toLowerCase();
        if (tag && !seen.has(key)) {
            seen.add(key);
            tags.push(tag);
        }
    }
    return tags;
}

// Returns a normalized absolute URL, or "" if the input isn't a usable http(s) link.
// Blocks javascript:, data:, etc. so a typed link can never run code when clicked.
export function safeUrl(input) {
    const text = String(input ?? "").trim();
    if (!text) return "";
    try {
        const url = new URL(text);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
        return "";
    }
}

// Raw form values -> clean project object. Unusable URLs become "".
export function normalizeProject(values, id) {
    const imageFile = String(values.imageFile ?? "").trim();
    return {
        id,
        title: String(values.title ?? "").trim(),
        description: String(values.description ?? "").trim(),
        tags: parseTags(values.tags),
        image: imageFile ? { file: imageFile, alt: String(values.imageAlt ?? "").trim() } : null,
        docsUrl: safeUrl(values.docsUrl),
        siteUrl: safeUrl(values.siteUrl),
        hidden: values.hidden === true,
    };
}

// Returns { field: message } for every problem; an empty object means valid.
// Checks the raw values so a typo'd URL is reported instead of silently dropped.
export function validateProject(values) {
    const errors = {};
    const text = (name) => String(values[name] ?? "").trim();
    if (!text("title")) errors.title = "Title is required.";
    else if (text("title").length > LIMITS.title) errors.title = `Keep the title under ${LIMITS.title} characters.`;
    if (!text("description")) errors.description = "Description is required.";
    else if (text("description").length > LIMITS.description) errors.description = `Keep the description under ${LIMITS.description} characters.`;

    const tags = parseTags(values.tags);
    if (tags.length > LIMITS.tags) errors.tags = `Use at most ${LIMITS.tags} tags.`;
    else if (tags.some((t) => t.length > LIMITS.tag)) errors.tags = `Each tag must be under ${LIMITS.tag} characters.`;

    for (const field of ["docsUrl", "siteUrl"]) {
        if (text(field) && !safeUrl(values[field])) {
            errors[field] = "Use a full link starting with http:// or https://";
        }
    }
    if (text("imageFile") && !text("imageAlt")) errors.imageAlt = "Describe the image for screen readers.";
    return errors;
}
