# Mosque Aisha display

Digital prayer-times screen for Mosque Aisha (Stanley Ave and Thorold), hosted on GitHub Pages.

| File | What it is |
| --- | --- |
| `index.html` | The screen. Open it full-screen on the TV. |
| `admin.html` | The admin dashboard. Change slides, notices, time changes and settings here. |
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
