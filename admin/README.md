# Project editor (Stage 1)

A browser-only editor for portfolio project cards. Everything lives in the page's memory:
nothing is saved, uploaded, or published, and a reload clears it.

This folder must not be deployed to the live site until Stage 2 adds server-side authentication.

## Run it

```bash
cd ~/dev/portfolio-website
npm run serve                       # http://127.0.0.1:8100, reachable only from the server itself
```

From your own computer, open a tunnel and browse to http://localhost:8100/admin/editor.html:

```bash
ssh -L 8100:localhost:8100 ubuntu@<server>
```

## Files

| File | Role |
|------|------|
| `admin/editor.html` | Form, live preview, and draft list. Loads the real `../style.css`. |
| `admin/editor.js` | In-memory state and event wiring. |
| `admin/editor.css` | Editor-only styles, all prefixed `editor-`. |
| `js/project-card.js` | Builds a card with the same markup as `index.html` (shared, reusable by the public page). |
| `js/project-utils.js` | Pure helpers: tag parsing, URL checking, validation. |

## Test it

```bash
npm test                            # unit tests for js/project-utils.js (Node built-in runner)

# End-to-end tests in headless Chromium (needs playwright-core):
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
CHROMIUM_PATH=/path/to/chrome-headless-shell \
npm run test:e2e
```

### Manual checklist

- [ ] Empty submit shows "Title is required" and "Description is required".
- [ ] Typing updates the live preview immediately.
- [ ] `Python, ML, python` shows two tags.
- [ ] A `javascript:` or `github.com/me` link shows an error and no button.
- [ ] No links → no button row; one link → one button.
- [ ] Uploading an image shows it in the preview; submitting without alt text is blocked.
- [ ] Edit loads a draft back into the form; Save changes updates it in place.
- [ ] Move up / Move down / Delete work; Delete asks first.
- [ ] Clicking a preview button opens a new tab and the drafts are still there.
- [ ] Reloading with drafts asks for confirmation, then everything is gone.
