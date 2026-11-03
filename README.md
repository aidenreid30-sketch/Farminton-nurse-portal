# Nurse Status Board

The nurse signs in and taps a button. Everyone else sees her status on a public board, which can be embedded in Google Sites.

- **Board:** `/`. Anyone can view it; no sign-in.
- **Board for Google Sites:** `/?embed=1`, a compact version for Insert → Embed.
- **Nurse page:** `/nurse`. Only the one account in the settings can sign in.
- **Change password:** `/nurse/password`. **Download history:** `/nurse/history.csv`.

It has no packages to install. It runs on Vercel, with Upstash Redis to save data.

## Put it on Vercel (about 10 minutes)

1. **Upload the code to GitHub.** Make a new **private** repository and upload everything in this folder **except `.env` and `data/`**. (`.gitignore` skips those with git, but not if you drag and drop files on github.com.)
   - With the GitHub CLI: `gh repo create nurse-status-board --private --source . --push`
2. **Create the Vercel project.** Go to **Add New → Project**, import the repository, set Framework Preset to **Other**, and click **Deploy**. The first deploy shows a "Setup needed" page; that's expected.
3. **Add the database.** In the project, open **Storage → Create Database → Upstash (Redis)**, use the free plan, and connect it to this project. Vercel adds the connection settings for you.
4. **Add the settings.** Under **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `NURSE_EMAIL` | her email address (the only account that can sign in) |
   | `NURSE_PASSWORD` | a starting password, 10+ characters. Mark it **Sensitive**. |
   | `SCHOOL_TIME_ZONE` | e.g. `America/Chicago` |
   | `CRON_SECRET` | any long random text (protects the daily reset job) |
   | `CHAT_WEBHOOK_URL` | optional, a Google Chat webhook |

5. **Redeploy.** Under **Deployments → ⋯ → Redeploy**, so the settings take effect.
6. **Sign in.** Open `https://<your-project>.vercel.app/nurse`, sign in, then click **Change password** right away.
7. **Add it to Google Sites:** **Insert → Embed → By URL**, then `https://<your-project>.vercel.app/?embed=1`.

**Forgot password?** Change `NURSE_PASSWORD` in Vercel and redeploy. That becomes her password, and every old sign-in ends.

## Run it on this computer

Double-click **Start.bat**. The first time, it creates `.env` for you to fill in. Locally it uses a stand-in database (`data/dev-store.json`), or Upstash if you put `KV_REST_API_URL` and `KV_REST_API_TOKEN` in `.env`.

## Security

| What | How |
|---|---|
| One account only | Only `NURSE_EMAIL` can sign in. Every failure gives the same "Email or password is incorrect", so it doesn't reveal which emails exist. |
| Passwords | Hashed with scrypt. A password she sets on the page is stored only as a hash. |
| Guessing | 5 wrong passwords lock sign-in from that address for 15 minutes. |
| Sessions | A random cookie that page scripts can't read and other sites can't send; only a hash of it is stored. Sign-ins expire after 12 hours. Changing the password ends all other sign-ins. |
| Other websites | Changes need the nurse page's token, must be JSON, and must come from the board's own site. |
| Pages | Text is escaped, with a strict Content-Security-Policy. Only the read-only board can be embedded; nurse pages can't be framed. |
| Double taps | A second change within 5 seconds is refused (enforced in the database). |
| End of day | After 4:30 PM on weekdays the board switches to "Gone for the Day", unless she changed it after 4:30. It happens when anyone views the board, with a daily Vercel job as backup. Change or turn it off with `dailyReset` in `config.json`. |
| Database use | Vercel keeps a 10-second copy of the public board, so many viewers stay within Upstash's free plan. |

## Settings

`config.json` holds the title, emergency note, status buttons, the double-tap wait, and the end-of-day reset. Edit it, push, and Vercel redeploys.

## Tests

`node --test`
