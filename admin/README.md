# Admin: project editor and publishing

Sign in at `/admin/` (link at the bottom of the home page). Projects you add or edit are saved
as drafts on the server; the home page only changes when you press **Publish**.

## How it fits together

```
browser ──► Caddy ──┬─ /admin*  ──► portfolio-admin (Python, 127.0.0.1:8091, user "portfolio")
                    │                  ├─ /var/lib/portfolio      drafts, uploads, backups (private)
                    │                  └─ on Publish writes ─┐
                    └─ everything else ◄─ /var/www/mywebsite ◄┘  static files only
```

- **Code** lives in this repo and is installed to `/opt/portfolio` (read-only to the service).
- **Login**: username `abc`, password in `/etc/.mywebsite_password` (root:portfolio, 0640).
  Change the password by editing that file; no restart needed. 5 wrong tries from one address
  locks it out for 15 minutes. Sessions last 8 hours.
- **Publishing** renders `index.html` (the template) with the visible projects between the
  `projects:start` / `projects:end` markers. With nothing published it shows "Projects coming soon…".
  "Restore previous version" swaps the live projects back one step.
- **Resume** uploads replace `assets/AnastasiaChengResume.pdf` immediately and bump its `?v=`
  so browsers fetch the new one. Old versions are kept in `/var/lib/portfolio/resume-history`.

| Path | Role |
|------|------|
| `server/app.py` | HTTP routes, sign-in, sessions, origin checks, security headers |
| `server/portfolio.py` | Drafts, publish, restore, image and resume uploads |
| `server/render.py` | Builds the public project cards (same markup as `js/project-card.js`) |
| `server/validation.py` | Server-side checks; mirrors `js/project-utils.js` |
| `server/store.py` | State file with revisions, atomic writes, history |
| `server/images.py` | Uploads -> resized WebP with metadata stripped |
| `admin/` | Editor and login pages |
| `deploy/` | systemd unit, Caddy site block, install script |
| `seed/` | The first two projects (`python3 -m server.seed seed/projects.json`) |

## Deploy

```bash
cd ~/dev/portfolio-website
sudo deploy/install.sh        # runs the tests first; stops if they fail
```

## Develop locally

```bash
mkdir -p .dev/site/assets && cp style.css .dev/site/ && echo "dev password" > .dev/password
python3 -m server.rebuild && npm run dev      # http://127.0.0.1:8091/admin/ (user abc)
```

## Tests

```bash
npm test                      # JS unit tests + Python server tests
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
CHROMIUM_PATH=/path/to/chrome-headless-shell \
npm run test:e2e              # full browser run against a temporary server
```
