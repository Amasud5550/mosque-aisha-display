# Sign in with Microsoft: one-time setup

About 20 minutes. You'll need admin access to **Mosque Aisha's Microsoft 365** and a **Cloudflare** account.

How it works: volunteers sign in to `admin.html` with their Mosque Aisha Microsoft account. A small Cloudflare Worker checks the sign-in is genuine, from Mosque Aisha's tenant, and in the **Display Admins** group, then saves the change to GitHub with a token only the Worker holds. Volunteers never need a GitHub account.

You'll collect four values along the way:

| Value | Where it comes from |
| --- | --- |
| Directory (tenant) ID | Step 1 |
| Application (client) ID | Step 1 |
| Display Admins group Object ID | Step 2 |
| Worker URL | Step 4 |

---

## 1. Register the app in Microsoft Entra

1. Go to **entra.microsoft.com** and sign in as a Mosque Aisha admin.
2. **Applications → App registrations → New registration**
   - Name: `Mosque Aisha Display Admin`
   - Supported account types: **Accounts in this organizational directory only (single tenant)**
   - Redirect URI: platform **Single-page application (SPA)**, URL
     `https://amasud5550.github.io/mosque-aisha-display/admin.html`
   - **Register**
3. On the app's **Overview**, copy the **Application (client) ID** and **Directory (tenant) ID**.
4. **Expose an API**
   - Next to *Application ID URI* click **Add** and accept the default (`api://<client-id>`), then **Save**.
   - **Add a scope**: Scope name `Display.Manage`, Who can consent **Admins and users**, display name `Manage the prayer display`, description `Edit slides, notices and settings for the Mosque Aisha prayer screens`. **Add scope**.
5. **API permissions → Add a permission → APIs my organization uses** (or **My APIs**) → `Mosque Aisha Display Admin` → **Delegated** → tick `Display.Manage` → **Add permissions**. Then click **Grant admin consent for Mosque Aisha** → **Yes**.
6. **Token configuration → Add groups claim** → tick **Security groups** → under *Access* choose **Group ID** → **Add**.
7. **Manifest**: set the access-token version to 2, then **Save**.
   - New manifest editor: in the `"api"` section, set `"requestedAccessTokenVersion": 2`
   - Older editor: set `"accessTokenAcceptedVersion": 2`

## 2. Create the Display Admins group

1. **Groups → All groups → New group**
   - Group type: **Security**
   - Name: `Display Admins`
   - Members: add yourself and anyone else who should edit the screens
   - **Create**
2. Open the group and copy its **Object ID**.

Adding or removing someone from this group is how you give or take away admin access. It takes effect the next time they sign in.

## 3. Make a GitHub token for the Worker

This token lives only inside Cloudflare, never in anyone's browser.

1. **github.com → Settings → Developer settings → Fine-grained tokens → Generate new token**
2. Name `Mosque Aisha display Worker`, expiry **1 year** (set yourself a calendar reminder to renew it)
3. Repository access: **Only select repositories → mosque-aisha-display**
4. Permissions: **Contents: Read and write**, **Actions: Read and write**
5. Generate and copy it.

## 4. Deploy the Worker on Cloudflare

**In the Cloudflare dashboard (no installs):**

1. **Workers & Pages → Create → Create Worker**. Name it `mosque-aisha-display-admin` → **Deploy**.
2. **Edit code**. Replace everything with the contents of `worker/src/index.js` → **Deploy**.
3. **Settings → Variables and Secrets → Add**:

   | Type | Name | Value |
   | --- | --- | --- |
   | Text | `TENANT_ID` | Directory (tenant) ID |
   | Text | `CLIENT_ID` | Application (client) ID |
   | Text | `ADMIN_GROUP_ID` | Display Admins Object ID |
   | Text | `ALLOWED_ORIGIN` | `https://amasud5550.github.io` |
   | Text | `GITHUB_OWNER` | `Amasud5550` |
   | Text | `GITHUB_REPO` | `mosque-aisha-display` |
   | **Secret** | `GITHUB_TOKEN` | the token from step 3 |

   **Deploy**.
4. Copy the Worker's URL from its overview page. It looks like
   `https://mosque-aisha-display-admin.<your-name>.workers.dev`.

*Or from a terminal:* fill in `worker/wrangler.toml`, then from the `worker/` folder run `npx wrangler login`, `npx wrangler secret put GITHUB_TOKEN`, `npx wrangler deploy`.

## 5. Turn it on in the admin page

In `admin.html` on GitHub, change the three `PASTE-…` values in the `ms-sign-in` line, and the Worker URL in the `Content-Security-Policy` line (both are near the top), then commit.

## 6. Try it

Open `https://amasud5550.github.io/mosque-aisha-display/admin.html` → **Sign in with Microsoft**.

| You see | Fix |
| --- | --- |
| "isn't in the Display Admins group" | Add the person to the group, wait a minute, sign in again |
| "Only Mosque Aisha accounts…" | They signed in with a personal or other organization's account |
| "permission to manage the display" | Step 1.5: grant admin consent |
| "Worker setting … is missing" | A variable in step 4.3 is missing or misspelled |
| "couldn't reach the GitHub repository" | The Worker's GitHub token is wrong or expired (step 3) |
| Redirect URI error from Microsoft | The redirect in step 1.2 must be **Single-page application** and exactly the admin.html address |
| Too many groups message | The person is in 200+ groups. In Token configuration, edit the groups claim to **Groups assigned to the application**, and assign the Display Admins group in Enterprise applications. |

The GitHub-token sign-in stays available under **Sign in with a GitHub token instead**, as a backup for you.
