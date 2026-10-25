// Builds one project card using the same markup and classes as index.html.
// Shared layer: the editor uses it now; the public page can use it once projects are stored.

// Every piece of user text goes through textContent, never innerHTML,
// so typing "<script>" into a field shows it as text instead of running it.
export function createProjectCard(project, doc = document) {
    const el = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    const card = el("div", "project");
    const text = el("div", "project-text");
    text.append(el("h3", "", project.title), el("p", "", project.description));

    if (project.tags.length) {
        const tags = el("div", "project-tags");
        for (const tag of project.tags) tags.append(el("span", "tag", tag));
        text.append(tags);
    }

    // URLs were already checked by safeUrl(); empty means "no button".
    const links = [
        [project.docsUrl, "Documentation"],
        [project.siteUrl, "View Website"],
    ].filter(([href]) => href);
    if (links.length) {
        const buttons = el("div", "buttons");
        for (const [href, label] of links) {
            const a = el("a", "", label);
            a.href = href;
            buttons.append(a);
        }
        text.append(buttons);
    }

    const preview = el("div", "project-preview");
    if (project.image) {
        const img = el("img");
        img.src = project.image.src;
        img.alt = project.image.alt;
        preview.append(img);
    }

    card.append(text, preview);
    return card;
}
