// Stage 1 project editor. All state lives in this module's variables:
// nothing is written to disk, a server, or browser storage.
import { normalizeProject, safeUrl, validateProject } from "../js/project-utils.js";
import { createProjectCard } from "../js/project-card.js";

const form = document.getElementById("project-form");
const fields = form.elements;
const livePreview = document.getElementById("live-preview");
const draftList = document.getElementById("draft-list");
const draftsEmpty = document.getElementById("drafts-empty");
const imageStatus = document.getElementById("image-status");
const removeImageButton = document.getElementById("remove-image");

let drafts = [];          // saved-for-preview projects, in display order
let editingId = null;     // id of the draft loaded into the form, or null for a new one
let nextId = 1;
let formImage = null;     // { src, fromFile } for the image currently in the form

// ---- Reading the form ----

function readForm() {
    return {
        title: fields.title.value,
        description: fields.description.value,
        tags: fields.tags.value,
        imageUrl: fields.imageUrl.value,
        imageSrc: formImage?.src ?? "",
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

// ---- Images ----
// Uploaded files become temporary blob: URLs that exist only in this tab.
// They are revoked once neither the form nor any draft uses them, to free memory.

function releaseUnusedBlobUrls(candidates) {
    const inUse = new Set(drafts.map((d) => d.image?.src));
    if (formImage) inUse.add(formImage.src);
    for (const src of candidates) {
        if (src?.startsWith("blob:") && !inUse.has(src)) URL.revokeObjectURL(src);
    }
}

function setFormImage(next) {
    const previous = formImage?.src;
    formImage = next;
    releaseUnusedBlobUrls([previous]);
    updateImageStatus();
}

function updateImageStatus() {
    if (!formImage) imageStatus.textContent = "No image.";
    else if (formImage.fromFile) imageStatus.textContent = "Using the uploaded file.";
    else imageStatus.textContent = "Using the image link.";
    removeImageButton.hidden = !formImage;
}

fields.imageFile.addEventListener("change", () => {
    const file = fields.imageFile.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
        fields.imageFile.value = "";
        imageStatus.textContent = "That file isn't an image.";
        return;
    }
    fields.imageUrl.value = "";
    setFormImage({ src: URL.createObjectURL(file), fromFile: true });
    renderLivePreview();
});

fields.imageUrl.addEventListener("input", () => {
    const url = safeUrl(fields.imageUrl.value);
    if (url) {
        fields.imageFile.value = "";
        setFormImage({ src: url, fromFile: false });
    } else if (formImage && !formImage.fromFile) {
        // The link was cleared or became invalid; an uploaded file is left alone.
        setFormImage(null);
    }
});

removeImageButton.addEventListener("click", () => {
    fields.imageFile.value = "";
    fields.imageUrl.value = "";
    setFormImage(null);
    renderLivePreview();
});

// ---- Rendering ----

function renderLivePreview() {
    const values = readForm();
    const project = normalizeProject(values, editingId ?? "preview");
    // Placeholder text keeps the card's shape visible while the form is empty.
    if (!project.title) project.title = "Project title";
    if (!project.description) project.description = "Your description will appear here.";
    livePreview.replaceChildren(createProjectCard(project));
}

function renderDrafts() {
    draftList.replaceChildren(...drafts.map((project, index) => {
        const wrapper = document.createElement("div");
        wrapper.className = "editor-draft";
        if (project.id === editingId) wrapper.classList.add("editor-draft-editing");

        const toolbar = document.createElement("div");
        toolbar.className = "editor-draft-toolbar";
        toolbar.append(
            toolbarButton("Edit", () => loadDraftIntoForm(project.id)),
            toolbarButton("Move up", () => moveDraft(index, -1), index === 0),
            toolbarButton("Move down", () => moveDraft(index, 1), index === drafts.length - 1),
            toolbarButton("Delete", () => deleteDraft(project.id)),
        );

        wrapper.append(toolbar, createProjectCard(project));
        return wrapper;
    }));
    draftsEmpty.hidden = drafts.length > 0;
}

function toolbarButton(label, onClick, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-button";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
}

// ---- Draft actions ----

function loadDraftIntoForm(id) {
    const project = drafts.find((d) => d.id === id);
    if (!project) return;
    editingId = id;
    fields.title.value = project.title;
    fields.description.value = project.description;
    fields.tags.value = project.tags.join(", ");
    fields.docsUrl.value = project.docsUrl;
    fields.siteUrl.value = project.siteUrl;
    fields.imageFile.value = "";   // browsers don't allow pre-filling a file input
    fields.imageAlt.value = project.image?.alt ?? "";
    const fromFile = project.image?.src.startsWith("blob:") ?? false;
    fields.imageUrl.value = project.image && !fromFile ? project.image.src : "";
    setFormImage(project.image ? { src: project.image.src, fromFile } : null);

    document.getElementById("form-heading").textContent = `Editing “${project.title}”`;
    document.getElementById("submit-button").textContent = "Save changes";
    document.getElementById("reset-button").textContent = "Cancel editing";
    showErrors({});
    renderLivePreview();
    renderDrafts();
    fields.title.focus();
}

function deleteDraft(id) {
    const project = drafts.find((d) => d.id === id);
    if (!project || !confirm(`Delete the draft “${project.title}”?`)) return;
    drafts = drafts.filter((d) => d.id !== id);
    if (editingId === id) resetForm();
    releaseUnusedBlobUrls([project.image?.src]);
    renderDrafts();
}

function moveDraft(index, offset) {
    const target = index + offset;
    if (target < 0 || target >= drafts.length) return;
    [drafts[index], drafts[target]] = [drafts[target], drafts[index]];
    renderDrafts();
}

function resetForm() {
    form.reset();
    editingId = null;
    setFormImage(null);
    document.getElementById("form-heading").textContent = "New project";
    document.getElementById("submit-button").textContent = "Add to drafts";
    document.getElementById("reset-button").textContent = "Clear form";
    showErrors({});
    renderLivePreview();
    renderDrafts();
}

// ---- Form events ----

form.addEventListener("submit", (event) => {
    event.preventDefault();   // stop the browser from submitting anywhere
    const values = readForm();
    const errors = validateProject(values);
    showErrors(errors);
    if (Object.keys(errors).length) {
        fields[Object.keys(errors)[0]].focus();
        return;
    }

    if (editingId) {
        const previous = drafts.find((d) => d.id === editingId);
        drafts = drafts.map((d) => (d.id === editingId ? normalizeProject(values, editingId) : d));
        const oldSrc = previous?.image?.src;
        formImage = null;   // the image now belongs to the draft, not the form
        releaseUnusedBlobUrls([oldSrc]);
    } else {
        drafts.push(normalizeProject(values, `draft-${nextId++}`));
        formImage = null;
    }
    resetForm();
});

document.getElementById("reset-button").addEventListener("click", resetForm);

// Re-render the live preview on every keystroke. Errors are cleared as you fix them
// but only shown on submit, so the form doesn't complain while you're still typing.
form.addEventListener("input", () => {
    renderLivePreview();
    const errors = validateProject(readForm());
    for (const p of form.querySelectorAll("[data-error-for]")) {
        if (p.textContent && !errors[p.dataset.errorFor]) {
            p.textContent = "";
            fields[p.dataset.errorFor].setAttribute("aria-invalid", "false");
        }
    }
});

// Links inside previews open in a new tab, so clicking one can't navigate away and lose your drafts.
for (const host of document.querySelectorAll(".editor-card-host")) {
    host.addEventListener("click", (event) => {
        const link = event.target.closest(".project a");
        if (!link) return;
        event.preventDefault();
        window.open(link.href, "_blank", "noopener");
    });
}

// Warn before a reload or tab close throws drafts away.
window.addEventListener("beforeunload", (event) => {
    if (drafts.length) event.preventDefault();
});

renderLivePreview();
renderDrafts();
