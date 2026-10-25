// Pure helpers for project data. No DOM access, so they run in Node tests too.

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
    const imageSrc = String(values.imageSrc ?? "").trim();
    return {
        id,
        title: String(values.title ?? "").trim(),
        description: String(values.description ?? "").trim(),
        tags: parseTags(values.tags),
        image: imageSrc ? { src: imageSrc, alt: String(values.imageAlt ?? "").trim() } : null,
        docsUrl: safeUrl(values.docsUrl),
        siteUrl: safeUrl(values.siteUrl),
    };
}

// Returns { field: message } for every problem; an empty object means valid.
// Checks the raw values so a typo'd URL is reported instead of silently dropped.
export function validateProject(values) {
    const errors = {};
    if (!String(values.title ?? "").trim()) errors.title = "Title is required.";
    if (!String(values.description ?? "").trim()) errors.description = "Description is required.";
    for (const field of ["docsUrl", "siteUrl"]) {
        if (String(values[field] ?? "").trim() && !safeUrl(values[field])) {
            errors[field] = "Use a full link starting with http:// or https://";
        }
    }
    if (String(values.imageUrl ?? "").trim() && !safeUrl(values.imageUrl)) {
        errors.imageUrl = "Use a full image link starting with http:// or https://";
    }
    if (String(values.imageSrc ?? "").trim() && !String(values.imageAlt ?? "").trim()) {
        errors.imageAlt = "Describe the image for screen readers.";
    }
    return errors;
}
