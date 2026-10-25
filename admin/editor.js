// Project editor. Drafts are saved to the server on every change;
// the public page only changes when Publish is pressed.
import { normalizeProject, validateProject } from "./js/project-utils.js";
import { createProjectCard } from "./js/project-card.js";

const $ = (id) => document.getElementById(id);
const form = $("project-form");
const fields = form.elements;

let server = null;        // last state from the server: { revision, drafts, status, pending, ... }
let editingId = null;     // id of the project loaded into the form, or null for a new one
let formImage = null;     // { file } of the uploaded image in the form
let busy = false;         // true while a request is in flight; prevents overlapping saves
let formDirty = false;    // unsaved typing in the form

const STATUS_LABELS = {
    live: "Live",
    changed: "Live · unpublished edits",
    new: "Not live yet",
    hidden: "Hidden",
    hiding: "Live · will be hidden when you publish",
};

// ---- Talking to the server ----

class ApiError extends Error {}

async function api(method, path, body, contentType = "application/json") {
    const response = await fetch(`/admin/api/${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": contentType },
        body: contentType === "application/json" && body !== undefined ? JSON.stringify(body) : body,
    });
    if (response.status === 401) {
        window.location.href = "/admin/login";
        throw new ApiError("Signed out");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status})`);
    return data;
}

// Runs one request at a time and refreshes the page from the server's reply.
// Resolves to true if the request succeeded.
async function run(task, successMessage = "") {
    if (busy) return false;
    busy = true;
    renderBar();
    setSaveStatus("Saving…");
    try {
        server = await task();
        setSaveStatus(successMessage || "All changes saved.");
        return true;
    } catch (err) {
        setSaveStatus(err.message, true);
        server = await api("GET", "state").catch(() => server);   // resync after a conflict or error
        return false;
    } finally {
        busy = false;
        renderAll();
    }
}

const saveDrafts = (drafts, message) =>
    run(() => api("PUT", "drafts", { revision: server.revision, drafts }), message);

function setSaveStatus(message, isError = false) {
    $("save-status").textContent = message;
    $("save-status").classList.toggle("editor-error", isError);
}

// ---- Reading the form ----

function readForm() {
    return {
        title: fields.title.value,
        description: fields.description.value,
        tags: fields.tags.value,
        imageFile: formImage?.file ?? "",
        imageAlt: fields.imageAlt.value,
        docsUrl: fields.docsUrl.value,
        siteUrl: fields.siteUrl.value,
    };
}

function showErrors(errors) {
    for (const p of form.querySelectorAll("[data-error-for]")) {
        const message = errors[p.dataset.errorFor] ?? "";
        p.textContent = message;
        fields[p.dataset.errorFor].setAttribute("aria-invalid", message ? "true" : "false");
    }
}

// Cards in the editor load images through the signed-in API; the public page uses assets/projects/.
const forCard = (project) => ({
    ...project,
    image: project.image && { src: `/admin/api/images/${project.image.file}`, alt: project.image.alt },
});

// ---- Images ----

function setFormImage(image) {
    formImage = image;
    $("image-status").textContent = image ? "Image uploaded." : "No image.";
    $("remove-image").hidden = !image;
}

fields.imageUpload.addEventListener("change", async () => {
    const file = fields.imageUpload.files[0];
    if (!file) return;
    $("image-status").textContent = "Uploading…";
    $("submit-button").disabled = true;
    try {
        const { file: name } = await api("POST", "images", file, file.type || "application/octet-stream");
        setFormImage({ file: name });
        formDirty = true;
    } catch (err) {
        $("image-status").textContent = err.message;
    } finally {
        fields.imageUpload.value = "";
        $("submit-button").disabled = false;
        renderLivePreview();
    }
});

$("remove-image").addEventListener("click", () => {
    setFormImage(null);
    renderLivePreview();
});

// ---- Rendering ----

function renderLivePreview() {
    const project = normalizeProject(readForm(), "preview");
    // Placeholder text keeps the card's shape visible while the form is empty.
    if (!project.title) project.title = "Project title";
    if (!project.description) project.description = "Your description will appear here.";
    $("live-preview").replaceChildren(createProjectCard(forCard(project)));
}

function renderBar() {
    const status = $("publish-status");
    if (!server) return;
    if (server.pending) status.textContent = "You have changes that aren't live yet.";
    else if (server.publishedAt) status.textContent = `Everything is live. Last published ${new Date(server.publishedAt).toLocaleString()}.`;
    else status.textContent = "Nothing published yet. The home page shows “coming soon”.";
    status.classList.toggle("editor-bar-pending", server.pending);
    $("publish-button").disabled = busy || !server.pending;
    $("submit-button").disabled = busy;
    $("restore-button").hidden = !server.canRestore;
    $("restore-button").disabled = busy;
}

function renderDrafts() {
    const drafts = server.drafts;
    $("draft-list").replaceChildren(...drafts.map((project, index) => {
        const wrapper = document.createElement("div");
        wrapper.className = "editor-draft";
        wrapper.classList.toggle("editor-draft-editing", project.id === editingId);
        wrapper.classList.toggle("editor-draft-hidden", project.hidden);

        const badge = document.createElement("span");
        badge.className = `editor-badge editor-badge-${server.status[project.id]}`;
        badge.textContent = STATUS_LABELS[server.status[project.id]];

        const toolbar = document.createElement("div");
        toolbar.className = "editor-draft-toolbar";
        toolbar.append(
            badge,
            toolbarButton("Edit", () => loadIntoForm(project.id)),
            toolbarButton("Move up", () => moveDraft(index, -1), index === 0),
            toolbarButton("Move down", () => moveDraft(index, 1), index === drafts.length - 1),
            toolbarButton(project.hidden ? "Show on site" : "Hide from site", () => toggleHidden(project.id)),
            toolbarButton("Delete", () => deleteDraft(project.id)),
        );
        wrapper.append(toolbar, createProjectCard(forCard(project)));
        return wrapper;
    }));
    $("drafts-empty").hidden = drafts.length > 0;
}

function toolbarButton(label, onClick, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-button";
    button.textContent = label;
    button.disabled = disabled || busy;
    button.addEventListener("click", onClick);
    return button;
}

function renderAll() {
    renderBar();
    renderDrafts();
    $("resume-link").href = `/assets/AnastasiaChengResume.pdf?v=${server.resumeVersion ?? ""}`;
}

// ---- Project actions ----

function loadIntoForm(id) {
    const project = server.drafts.find((d) => d.id === id);
    if (!project) return;
    editingId = id;
    fields.title.value = project.title;
    fields.description.value = project.description;
    fields.tags.value = project.tags.join(", ");
    fields.docsUrl.value = project.docsUrl;
    fields.siteUrl.value = project.siteUrl;
    fields.imageAlt.value = project.image?.alt ?? "";
    setFormImage(project.image ? { file: project.image.file } : null);

    $("form-heading").textContent = `Editing “${project.title}”`;
    $("submit-button").textContent = "Save changes";
    $("reset-button").textContent = "Cancel editing";
    formDirty = false;
    showErrors({});
    renderLivePreview();
    renderDrafts();
    form.scrollIntoView({ behavior: "smooth" });
    fields.title.focus({ preventScroll: true });
}

function resetForm() {
    form.reset();
    editingId = null;
    formDirty = false;
    setFormImage(null);
    $("form-heading").textContent = "New project";
    $("submit-button").textContent = "Add to drafts";
    $("reset-button").textContent = "Clear form";
    showErrors({});
    renderLivePreview();
    renderDrafts();
}

function deleteDraft(id) {
    const project = server.drafts.find((d) => d.id === id);
    if (!project || !confirm(`Delete “${project.title}”? If it's live, it disappears from the site at the next Publish.`)) return;
    if (editingId === id) resetForm();
    saveDrafts(server.drafts.filter((d) => d.id !== id), "Project deleted.");
}

function moveDraft(index, offset) {
    const drafts = [...server.drafts];
    const target = index + offset;
    if (target < 0 || target >= drafts.length) return;
    [drafts[index], drafts[target]] = [drafts[target], drafts[index]];
    saveDrafts(drafts);
}

function toggleHidden(id) {
    saveDrafts(server.drafts.map((d) => (d.id === id ? { ...d, hidden: !d.hidden } : d)));
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();   // the browser never submits this form anywhere; we send JSON instead
    const values = readForm();
    const errors = validateProject(values);
    showErrors(errors);
    if (Object.keys(errors).length) {
        fields[Object.keys(errors)[0]].focus();
        return;
    }
    const existing = server.drafts.find((d) => d.id === editingId);
    const project = normalizeProject({ ...values, hidden: existing?.hidden ?? false }, editingId ?? crypto.randomUUID());
    const drafts = existing
        ? server.drafts.map((d) => (d.id === editingId ? project : d))
        : [...server.drafts, project];
    if (await saveDrafts(drafts, existing ? "Changes saved as a draft." : "Added to drafts.")) resetForm();
});

$("reset-button").addEventListener("click", resetForm);

// Re-render the live preview on every keystroke. Errors are cleared as you fix them
// but only shown on submit, so the form doesn't complain while you're still typing.
form.addEventListener("input", () => {
    formDirty = true;
    renderLivePreview();
    const errors = validateProject(readForm());
    for (const p of form.querySelectorAll("[data-error-for]")) {
        if (p.textContent && !errors[p.dataset.errorFor]) {
            p.textContent = "";
            fields[p.dataset.errorFor].setAttribute("aria-invalid", "false");
        }
    }
});

// ---- Publishing and resume ----

$("publish-button").addEventListener("click", () => {
    if (!confirm("Publish now? Visitors will see the visible projects in this order.")) return;
    run(() => api("POST", "publish", { revision: server.revision }), "Published. The home page is updated.");
});

$("restore-button").addEventListener("click", () => {
    if (!confirm("Put the previous version of the projects back on the home page? Your drafts aren't changed.")) return;
    run(() => api("POST", "restore", { revision: server.revision }), "Previous version restored on the home page.");
});

$("resume-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = $("resumeFile").files[0];
    if (!file) return;
    if (!confirm(`Replace the live resume with “${file.name}”? This takes effect immediately.`)) return;
    if (await run(() => api("POST", "resume", file, "application/pdf"), "Resume replaced. The site links to the new file.")) {
        $("resume-form").reset();
    }
});

// ---- Page-wide behaviour ----

// Links inside previews open in a new tab, so clicking one never leaves the editor.
for (const host of document.querySelectorAll(".editor-card-host")) {
    host.addEventListener("click", (event) => {
        const link = event.target.closest(".project a");
        if (!link) return;
        event.preventDefault();
        window.open(link.href, "_blank", "noopener");
    });
}

// Drafts are saved on the server, so only unsaved typing in the form needs a warning.
window.addEventListener("beforeunload", (event) => {
    if (formDirty || busy) event.preventDefault();
});

renderLivePreview();
api("GET", "state")
    .then((state) => {
        server = state;
        renderAll();
        setSaveStatus("");
    })
    .catch((err) => setSaveStatus(err.message, true));
