# Endless Mountains Pride — Volunteer Hub

A mobile-first, installable Progressive Web App (PWA) for recruiting, scheduling, and reminding volunteers for **Endless Mountains Pride** at Mountaineer Park — powered directly by **Google Sheets + Google Apps Script** with **$0/month hosting** on GitHub Pages.

## Features
- **Manage Shifts in Google Sheets**: Add or edit rows in the `Shifts` tab with `Date`, `Location`, `Volunteers Needed`, `Time Range` (e.g., `10:00 AM - 5:00 PM` or `10 am to 5 pm`), `Shift Length (hrs)` (e.g., `2`, `1`, `1.5`, or `Full`), `Description`, `Category`, and `Check-in Note`. Long spans automatically split into clean shift blocks!
- **Atomic Slot Locking (No Double-Booking)**: Once volunteers fill all available spots for a time slot, that slot immediately switches to **Full · Unavailable**. Uses Google Apps Script `LockService` so two people clicking the last spot simultaneously can never overbook.
- **Self-Service Changes & Cancellations**: Volunteers sign up with their **Name, Email, and Phone Number**, receive a **6-character Manage Code + 1-click Magic Link** by email, and can **Swap to another open slot** or **Remove themselves** anytime — immediately reopening their old spot for someone else.
- **Multi-Channel Reminders (Day-Before + 15 Minutes Before)**:
  - **Day-Before Email**: Consolidated morning-before summary email listing every shift a volunteer signed up for tomorrow, with check-in notes and an attached `.ics` calendar file.
  - **15-Minute-Before Email**: Automated email sent ~15 minutes before each shift starts with station, duties, and check-in note.
  - **15-Minute Browser/PWA Notification + Chime**: In-app alert banner, gentle chime, and native notification 15 minutes before shift start.
  - **Phone Calendar (`.ics`) Alarm**: 1-click `.ics` download (and email attachment) with a built-in `VALARM` (`-PT15M`) for reliable lock-screen alarms on iOS and Android even when the browser is closed.

---

## Connected Google Spreadsheet
- **Spreadsheet**: [Endless Mountains Pride - Volunteer Schedule](https://docs.google.com/spreadsheets/d/1DlMO46XIRxLcecUuuNHkvygCx3Ss7wlT9oTBcwjvxEE/edit)
- **Sheet ID**: `1DlMO46XIRxLcecUuuNHkvygCx3Ss7wlT9oTBcwjvxEE`

### Tabs
1. **`Shifts`** — Where you list every station, date, headcount needed, time range, shift length, and duty description.
2. **`Signups`** — Automatically updated whenever someone signs up, swaps, or cancels (tracks `Confirmed` vs `Cancelled`, plus timestamps for `Day-Before Reminder Sent` and `15-Min Reminder Sent`).
3. **`Settings`** — Festival name, venue, timezone (`America/New_York`), coordinator contact info, check-in instructions, announcement banner, and the hour to send day-before emails.

---

## 3-Minute Setup to Go Live (Real Sync + Automated Emails)

> Until Step 3 is completed, the app runs automatically in **Interactive Preview Mode** (saving test signups locally in your browser so you can try every feature immediately).

### Step 1: Attach the Google Apps Script Backend
1. Open [Endless Mountains Pride - Volunteer Schedule](https://docs.google.com/spreadsheets/d/1DlMO46XIRxLcecUuuNHkvygCx3Ss7wlT9oTBcwjvxEE/edit).
2. In the top menu, click **Extensions → Apps Script**.
3. Delete any starter `myFunction()` code in `Code.gs`, paste the entire contents of [`apps-script/Code.gs`](./apps-script/Code.gs), and click **Save** (💾).

### Step 2: Deploy as a Web App
1. In the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon next to *Select type* and choose **Web app**.
3. Configure:
   - **Description**: `Volunteer Hub API`
   - **Execute as**: **Me** (your Google account — allows the script to edit the sheet and send confirmation/reminder emails)
   - **Who has access**: **Anyone**
4. Click **Deploy**, authorize the requested Google permissions when prompted, and copy the **Web app URL** (it ends in `/exec`).

### Step 3: Connect the Web App URL
1. Open [`config.js`](./config.js) and paste your `/exec` URL into `APPS_SCRIPT_URL`:
   ```js
   APPS_SCRIPT_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',
   ```
2. Commit and push to GitHub (or test immediately by clicking **⚙️ Setup** in the app's top-right corner and pasting the URL there).

### Step 4: Turn On Automated Day-Before & 15-Minute Reminder Emails
1. Reload your Google Sheet tab in your browser.
2. You will see a new custom menu at the top: **🏳️‍🌈 Volunteer Hub**.
3. Click **🏳️‍🌈 Volunteer Hub → ✅ Enable Automated Reminders (Day-Before + 15-Min)**.
4. Optional: click **📧 Send Test Reminder Email to Me** to preview the formatted email and `.ics` calendar attachment in your inbox!

---

## Free Hosting on GitHub Pages
1. Open your repository settings on GitHub: `EndlessMountainsPride/volunteers → Settings → Pages`.
2. Under **Build and deployment → Source**, choose **Deploy from a branch** → branch **`main`** → folder **`/ (root)`** → **Save**.
3. Your Volunteer Hub will be live at `https://endlessmountainspride.github.io/volunteers/` (already set in the Google Sheet `Settings` tab for 1-click email magic links!).

## Local Preview
```bash
python3 -m http.server 8080
```
Then open `http://localhost:8080` in a browser.
