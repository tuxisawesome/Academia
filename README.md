# Academia

A self-hosted library for PDFs, with **Notebooks** and **Bookmarks** kept in folders.

- **Notebooks** are ordered PDF pages. You can:
  - upload a PDF to the end of a notebook, or insert it at any page
  - delete pages (with undo), drag to reorder, and rotate
  - download the whole notebook as one PDF whose outline (PDF bookmarks) points at your Bookmarks
- **Bookmarks** point at one or more pages of a notebook, including non-contiguous ranges such as `pp. 3–7, 10, 12–15`.
  - You pick the pages from thumbnails: click, Shift-click, drag across pages, or type ranges.
  - A bookmark keeps pointing at the same pages when the notebook is moved, renamed or reordered.
  - You can edit a bookmark's pages later.
  - Downloading a bookmark gives a PDF of just its pages, labelled with their original page numbers.
- **Pinned folders**: pin folders to the top of the sidebar (right-click → *Pin to sidebar*, or drag a folder onto *Pinned*). Reorder them by dragging.
- **Search** with two collapsible sections:
  - **Files**: folders, notebooks and bookmarks whose names match.
  - **Contents**: the pages whose text matches, shown as page thumbnails that open the reader on that page.
  - From the Library, search covers everything. Inside a folder, it covers that folder and all its subfolders.
  - Typed PDFs are searchable right after upload.
  - Handwriting is read by the browsers you use, on their own graphics card. Search tolerates the small misreads messy handwriting produces.
  - The recognised text is used only for search: it is never shown and never added to downloaded PDFs.
- **File browser** that works like Windows Explorer:
  - grid and list views
  - right-click menus, multi-select (Ctrl/Shift-click, rubber-band, Ctrl+A)
  - drag and drop, including PDFs dropped in from your desktop
  - cut/copy/paste and rename (F2)
  - coloured folders, search, and a Trash that keeps items for 30 days
- **Reader**:
  - two pages side by side on wide screens, one page on phones
  - keyboard, click and swipe to turn pages
  - page thumbnails, bookmarks panel, zoom and fullscreen
  - reopens where you left off
- **Accounts**:
  - private libraries per user
  - an administrator adds and manages accounts; there is no public sign-up
- **Export** (Settings → Export) creates a ZIP of all your PDFs in your folder structure, with or without bookmarks embedded in the PDFs.
- **Installable app (PWA)**:
  - light and dark themes, serif typography
  - online-only by design: nothing is stored on the device, and without a connection it shows a "connect and try again" page

## Installing on Ubuntu Server

**Requirements:**
- A server running **Ubuntu Server 24.04 LTS or 26.04 LTS** (amd64 or arm64), with 1 GB of RAM or more.
- A **domain name** whose DNS `A` record points at the server.
- Ports **80 and 443** reachable from the internet (for the automatic Let's Encrypt certificate).

**Option 1: from a clone of this repository**

```bash
git clone https://github.com/tuxisawesome/Academia.git
cd Academia
sudo ./deploy/install.sh
```

**Option 2: one line, without cloning**

```bash
curl -fsSL https://raw.githubusercontent.com/tuxisawesome/Academia/main/deploy/install.sh | sudo bash
```

**The installer asks all of its questions first:**
- how Academia should be served:
  - automatic HTTPS with Let's Encrypt
  - a self-signed certificate
  - plain HTTP behind your own proxy or tunnel
- the domain name
- an optional email for certificate notices
- the administrator's username and password (press Enter to generate one)
- whether to enable the firewall

It then shows a summary and asks for confirmation. After that it runs unattended to the end, which takes about 5 minutes. When it finishes, it prints the address and the administrator's sign-in details. A generated password is also saved to `/root/academia-credentials.txt`, and you're asked to change it at first sign-in.

Every question can be answered in advance, which makes the install fully non-interactive:

```bash
sudo ./deploy/install.sh --domain academia.example.com --email you@example.com \
  --admin-user admin --firewall yes --yes
```

| Option | Meaning |
|---|---|
| `--domain NAME` | Domain name for the site |
| `--tls auto\|internal\|off` | Let's Encrypt (default), self-signed, or plain HTTP behind another proxy |
| `--http-port PORT` | Port used with `--tls off` (default 8080) |
| `--email ADDRESS` | Email for Let's Encrypt notices |
| `--admin-user NAME`, `--admin-password PASS` | First administrator (default: `admin`, generated password) |
| `--firewall yes\|no` | Enable UFW, allowing only SSH (on its real port), HTTP and HTTPS |
| `--repo URL`, `--branch NAME` | Install from another repository or branch/tag |
| `-y, --yes` | Use defaults for anything not given and skip the confirmation |

Running the installer again is safe. It repairs or updates the installation and keeps all accounts and data.

### What gets installed

| Path | Contents |
|---|---|
| `/opt/academia/releases/<commit>` | Built versions of the app; `/opt/academia/current` points at the active one |
| `/opt/academia/src` | Git checkout used to fetch updates |
| `/opt/academia/tools`, `/opt/academia/python` | Pinned uv, Python 3.13 and Node.js (Node only builds the web app) |
| `/var/lib/academia` | **Your data**: database, uploaded PDFs, thumbnails, caches, backups, and the mirrored recognition model files (`models/`) |
| `/etc/academia/academia.env` | Settings (upload size limit, cache size, …) |
| `/etc/caddy/sites/academia.caddy` | Web server configuration (Caddy: HTTPS, compression) |

**Services:**
- `academia.service`: the app. It runs as the unprivileged `academia` user, is sandboxed by systemd, and listens only on `127.0.0.1:8750`.
- `academia-backup.timer`: nightly database backup; the last 14 are kept.
- `academia-maint.timer`: nightly housekeeping. It empties the Trash after 30 days, removes deleted pages after 7 days, and trims caches.

### Handwriting recognition (runs in your browser)

The server only stores the text; your browsers do the actual reading. This keeps the server small and cheap.

**How it works:**
1. While Academia is open on a computer with a capable graphics card, that browser quietly reads unread pages in the background, newest uploads first.
2. It renders each page itself and runs a vision-language model with WebGPU: Qwen3.5 2B, or 0.8B on smaller GPUs (Apache-2.0).
3. It sends back only the text.

**Model download:**
- The first time, each browser downloads the model: about 2.1 GB, or 0.8 GB for the light model.
- It's kept in the browser for next time.
- The server fetches the model files from Hugging Face once, the first time a browser asks, and keeps them in `/var/lib/academia/models`. The server therefore needs outbound internet access, and about 3 GB of disk if both models are used.

**Devices:**
- Several open devices share the work.
- A page read with the light model is read again later by a device using the standard model.
- Settings → **Text recognition** shows progress. There you can turn reading on or off for the current device (it's on by default for computers and off for phones), choose the model, or have everything read again.
- It needs a browser with WebGPU: current Chrome, Edge and Safari, and Firefox on Windows/macOS. On Linux, check `chrome://gpu`.

## Updating

```bash
sudo academia-update              # update to the newest version of the installed branch
sudo academia-update --check      # only check whether an update is available
sudo academia-update --ref v1.2.0 # update (or downgrade) to a specific tag, branch or commit
sudo academia-update --rollback   # go back to the version before the last update
```

**How an update runs:**
1. The new version is built in its own folder while the current one keeps serving.
2. Academia is stopped and the database is backed up.
3. The database is migrated.
4. Academia switches to the new version and waits for it to report healthy. It is offline only for a few seconds, and open browser tabs show a short "updating" page.

**If something goes wrong:**
- If the migration or the start-up check fails, the previous version and database are restored automatically.
- `--rollback` also restores the database backup taken just before the last update. Changes made since that update are lost, so it asks first.

After an update, open browser tabs show **"Academia has been updated — Reload"**.

## Administration

- **Managing users:** Administrators manage accounts in the web app (avatar menu → **Manage users**): add users, reset passwords, disable, make administrator, delete. New users get a temporary password and choose their own at first sign-in.
- **Command line:** the same tasks are available from a shell on the server, which is useful if you're locked out:

  ```bash
  sudo academia list-users
  sudo academia create-user alice [--admin]
  sudo academia reset-password alice
  sudo academia set-admin alice [--off]
  sudo academia enable alice
  sudo academia backup            # extra database backup now
  sudo academia version
  ```

- **Logs:** `sudo journalctl -u academia -f` (web server: `sudo journalctl -u caddy`).
- **Settings:** edit `/etc/academia/academia.env`, then run `sudo systemctl restart academia`.

  | Setting | Default | Meaning |
  |---|---|---|
  | `ACADEMIA_MAX_UPLOAD_MB` | 1024 | Largest PDF that can be uploaded |
  | `ACADEMIA_PDF_CACHE_MAX_MB` | 4096 | Disk space for generated PDFs (rebuilt when needed) |
  | `ACADEMIA_PDF_WORKERS` | half the CPU cores, at most 4 | Parallel PDF rendering and assembly |

### Backups and restore

Everything lives in `/var/lib/academia`:
- `db/academia.db`: the database
- `sources/`: the uploaded PDFs
- `thumbs/` and `cache/`: can be regenerated, so they don't need backing up

The nightly timer keeps 14 database backups in `/var/lib/academia/backups`.

**For a full off-server backup:**

```bash
sudo academia backup --label manual --keep 0      # consistent copy of the database
sudo tar -C /var/lib/academia -czf academia-backup.tgz db/academia.db backups sources
```

**To restore a database backup:**

```bash
sudo systemctl stop academia
sudo cp /var/lib/academia/backups/academia-nightly-YYYYMMDD-HHMMSS.db /var/lib/academia/db/academia.db
sudo rm -f /var/lib/academia/db/academia.db-wal /var/lib/academia/db/academia.db-shm
sudo chown academia:academia /var/lib/academia/db/academia.db
sudo systemctl start academia
```

Uploaded PDFs that are no longer used are kept for 21 days before being deleted. Restoring a database backup from the last two weeks therefore never refers to missing files.

**To move to a new server:**
1. Install Academia there.
2. Stop the service.
3. Copy `db/academia.db` and `sources/` into `/var/lib/academia`, then run `sudo chown -R academia:academia /var/lib/academia`.
4. Start the service.

### Uninstalling

```bash
sudo systemctl disable --now academia academia-backup.timer academia-maint.timer
sudo rm /etc/systemd/system/academia*.{service,timer} /etc/caddy/sites/academia.caddy
sudo systemctl daemon-reload && sudo systemctl reload caddy
sudo rm -rf /opt/academia /etc/academia /usr/local/bin/academia /usr/local/bin/academia-update
# Your data stays in /var/lib/academia until you delete it:  sudo rm -rf /var/lib/academia
```

### Troubleshooting

- **The site doesn't load over HTTPS.**
  - Check that the domain's DNS points at the server and that ports 80 and 443 are open (including any cloud firewall).
  - Then look at `sudo journalctl -u caddy -n 100`. The certificate is issued automatically as soon as the domain resolves.
- **You're locked out.** `sudo academia reset-password <user>` prints a new temporary password.
- **An update failed.** It was rolled back automatically, and the reason is in `/var/log/academia-install.log` and `sudo journalctl -u academia`.

## Development

**Requirements:** Linux or macOS, Python 3.13 and Node.js 24 (both installed for you by the bootstrap script, into `~/.local` without root).

```bash
scripts/dev-bootstrap.sh   # installs uv + Node.js locally, then the dependencies
scripts/dev.sh             # backend on :8000 (auto-reload) + Vite on :5173
```

Open <http://localhost:5173> and sign in as `admin` / `academia-dev`. Development data lives in `./data`.

**Tests:**

```bash
cd backend && uv run pytest               # API, PDF assembly, trash, export, property-based page-order tests
cd backend && uv run ruff check .
cd frontend && npm run typecheck && npm run lint && npm test
cd frontend && npm run build && npm run e2e   # Playwright end-to-end tests (uses system Chromium if present)
```

### How it's built

**Backend** (`backend/`): Python 3.13, FastAPI, SQLAlchemy, Alembic and SQLite.
- **pikepdf** validates uploads and builds the downloaded PDFs, including outlines and page labels.
- **pypdfium2** renders page thumbnails.
- PDF work runs in a separate process pool.
- Uploaded PDFs are stored once and never modified.
- A notebook is an ordered list of page references into them. A bookmark is a set of those page ids, which is why it follows its pages through moves, inserts and reordering.
- Generated PDFs are cached under a hash of their contents.
- Page text, both the PDFs' own text layers and handwriting recognised in browsers, is stored per page of each uploaded PDF in a SQLite FTS5 index.
- Typo-tolerant search expands each word to close spellings found in the index's vocabulary, using rapidfuzz.
- Browsers fetch pages to read and submit results through `/api/ocr/*`. Each claimed page is leased to one device so devices don't duplicate work. Each engine has a quality rank, so better models replace results from weaker ones.

**Frontend** (`frontend/`):
- React, TypeScript and Vite, with TanStack Query and Radix UI primitives.
- **pdf.js** powers the reader.
- Handwriting recognition runs in a Web Worker with **transformers.js** on WebGPU. Model files come from the server's `/api/models/` mirror, so the app's Content-Security-Policy can stay `connect-src 'self'`.
- A hand-written service worker caches only the offline page.

**Deployment** (`deploy/`):
- `install.sh` is a self-contained installer and also the function library that `update.sh` uses.
- `bin/academia-update` fetches a version and runs that version's `update.sh`.
- Caddy terminates TLS and proxies to uvicorn.

**Database changes:** add an Alembic migration in `backend/migrations/versions/`. To generate one, run `cd backend && uv run alembic revision --autogenerate -m "…"`. Updates apply migrations automatically, after taking a backup.
