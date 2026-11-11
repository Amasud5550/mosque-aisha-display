# Mosque Aisha display

Digital prayer-times screen for Mosque Aisha (Stanley Ave and Thorold), hosted on GitHub Pages.

| File | What it is |
| --- | --- |
| `index.html` + `screen.js` | The screen. Open it full-screen on the TV. Portrait TVs get the tall layout, landscape TVs the wide one. |
| `sw.js` | Offline cache so screens keep working through internet outages. |
| `admin.html` + `admin.js` | The admin dashboard. Change slides, notices, time changes and settings here. |
| `config.json` | Everything the admin page edits. Don't edit by hand unless you have to. |
| `prayerTimes.json` | Backup copy of the times from mosqueaisha.ca, refreshed every 30 minutes. |
| `announcements/` | Images uploaded from the admin page. |
| `.github/workflows/update-prayer-times.yml` | The job that refreshes `prayerTimes.json`. |

## Screen link

The kiosk PC (Intune policy) opens `https://amasud5550.github.io/mosque-aisha-display/`.
It shows the mosque chosen under **Settings → Default location** in the admin page.
`index.html` must stay at the root of this repo or that address stops working.

For an extra screen that should always show one mosque, add `?location=1` (Stanley Ave) or `?location=2` (Thorold).

Screens check for admin changes every 2 minutes and reload themselves just after midnight.

## Admin

`https://amasud5550.github.io/mosque-aisha-display/admin.html`

Sign in with a GitHub fine-grained token:

1. GitHub → Settings → Developer settings → Fine-grained tokens → **Generate new token**
2. Repository access: **Only select repositories** → `mosque-aisha-display`
3. Permissions: **Contents: Read and write**, **Actions: Read and write**
4. Paste it into the admin page. It's stored only in that browser.

To give another volunteer access, add them as a collaborator on this repo (Settings → Collaborators). They then create their own token.

## Where prayer times come from

The screen reads the same API as mosqueaisha.ca (`api.mosqueaisha.ca/mosque-api`). That API currently only accepts requests from mosqueaisha.ca, so the screen falls back to `prayerTimes.json`, which the GitHub Action keeps up to date. If the API owner adds `https://amasud5550.github.io` to its allowed origins, the screen will read it live.

Change times permanently in the mosque website's admin. Use **Time changes** in this admin to override a time on the screens only.

## Security

- **Admin access is a GitHub token.** Use a *fine-grained* token for this repo only (Contents + Actions: Read and write) with an expiry date. The admin page warns if you sign in with a classic token, which could change all of your repositories. Turn on two-factor authentication for your GitHub account.
- The token is stored only in the browser you sign in on. Use **Settings → Sign out on this device** on shared computers.
- `admin.html` only runs `admin.js` and can only talk to `api.github.com` (Content Security Policy), refuses to load inside another site's frame, and treats `config.json` and `prayerTimes.json` as untrusted: every value is type-checked and escaped.
- Uploads must be real JPG, PNG, WebP or GIF files (checked by file signature). SVG is refused because it can carry scripts.
- The GitHub job runs with write access to repo contents only, uses an action pinned to an exact commit, accepts HTTPS only, caps response size, and rejects any data from mosqueaisha.ca that doesn't look like prayer times. A rejected run leaves the last good times in place.
- The screen (`index.html` + `screen.js`) holds no secrets. It runs under its own Content Security Policy and also validates everything it reads.

## Reliability

- `sw.js` keeps an offline copy of the screen, fonts and slides, so a TV can start and keep running when the internet is down. The page also keeps the last prayer times it saw.
- The midnight reload and "Reload all screens" only happen when the site is reachable, so an outage can't leave a TV on an error page.
- Screens check `config.json` every 2 minutes using ETags, so unchanged checks don't use up GitHub's hourly request limit shared by all screens on one network.
