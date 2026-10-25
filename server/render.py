"""Builds the public index.html from the template and the published projects."""
import html
import re

START = "<!-- projects:start -->"
END = "<!-- projects:end -->"
RESUME_RE = re.compile(r"(AnastasiaChengResume\.pdf\?v=)(\d+)")
STYLE_RE = re.compile(r'href="style\.css(\?v=[^"]*)?"')
COMING_SOON = '<p class="coming-soon">Projects coming soon&hellip;</p>'


def _e(text):
    return html.escape(text, quote=True)


# Same structure and classes as js/project-card.js; the e2e test checks they match.
def card_html(project, image_base="assets/projects/"):
    lines = [
        '<div class="project">',
        '    <div class="project-text">',
        f"        <h3>{_e(project['title'])}</h3>",
        f"        <p>{_e(project['description'])}</p>",
    ]
    if project["tags"]:
        lines.append('        <div class="project-tags">')
        lines += [f'            <span class="tag">{_e(tag)}</span>' for tag in project["tags"]]
        lines.append("        </div>")
    links = [(project["docsUrl"], "Documentation"), (project["siteUrl"], "View Website")]
    links = [(href, label) for href, label in links if href]
    if links:
        lines.append('        <div class="buttons">')
        lines += [f'            <a href="{_e(href)}">{label}</a>' for href, label in links]
        lines.append("        </div>")
    lines.append("    </div>")
    image = project["image"]
    if image:
        src = _e(image_base + image["file"])
        lines.append(f'    <div class="project-preview"><img src="{src}" alt="{_e(image["alt"])}" loading="lazy"></div>')
    else:
        lines.append('    <div class="project-preview"></div>')
    lines.append("</div>")
    return lines


def parse_resume_version(template):
    match = RESUME_RE.search(template)
    return int(match.group(2)) if match else None


def render_page(template, projects, resume_version=None, style_version=None):
    if template.count(START) != 1 or template.count(END) != 1:
        raise ValueError("Template needs exactly one projects:start and one projects:end marker")
    head, rest = template.split(START)
    _, tail = rest.split(END)
    indent = head[head.rfind("\n") + 1:]   # whitespace before the start marker

    body = []
    for project in projects:
        body += card_html(project)
        body.append("")
    if not projects:
        body = [COMING_SOON, ""]
    inner = "\n".join(indent + line if line else "" for line in body)

    page = f"{head}{START}\n{inner}{indent}{END}{tail}"
    if resume_version is not None:
        page = RESUME_RE.sub(lambda m: f"{m.group(1)}{resume_version}", page)
    if style_version:
        # A new ?v= whenever style.css changes, so browsers can't keep using an old cached copy.
        page = STYLE_RE.sub(f'href="style.css?v={style_version}"', page)
    return page
