# Finfinity Loan Chatbot — WordPress plugin

## What this is
A single WordPress plugin that loads the loan-eligibility chat widget on every page of the site.
It bundles the exact same `widget.js` the chatbot team builds and tests with — this isn't a
separate integration, just the normal embed wrapped as a plugin.

## Install
1. Zip the `finfinity-loan-chatbot/` folder (so the zip contains `finfinity-loan-chatbot/finfinity-loan-chatbot.php` at its top level, not nested another level deeper).
2. WordPress admin → **Plugins → Add New → Upload Plugin** → choose the zip → **Install Now** → **Activate**.
3. Go to **Settings → Finfinity Chatbot** and paste in the backend's real, public, HTTPS URL (e.g. `https://chatbot-api.finfinity.co.in`) — no trailing slash. Save.
4. The chat button should now appear on every front-end page (bottom-right, fixed position). Nothing else needs to change on the site.

**The widget stays invisible until step 3 is done** — safe to install ahead of the backend being ready.

## Updating the widget later
When the chatbot team ships a new build: replace `assets/widget.js` inside the plugin folder with
the new file, re-zip, and re-upload the same way (WordPress overwrites the existing plugin). The
API URL setting is stored separately in the database and isn't affected by this.

## One thing the website team needs to coordinate with the chatbot team on
The backend's CORS allow-list needs this site's real domain added before requests will work (this
is a server-side config change on the chatbot team's end, not something this plugin controls) —
let them know the exact domain(s) this site is served from (e.g. `https://www.finfinity.co.in` and
any staging domain) so they can add it.
