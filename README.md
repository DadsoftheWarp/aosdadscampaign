# AoS Dads Campaign Tracker

A Firebase-backed standalone tracker for the Age of Sigmar escalation campaign.

## What this is

- A web app built from the existing `aos_campaign_tracker.html` prototype.
- Tracks roster, schedule, pairings, campaign log entries, and standings.
- Uses Firebase Authentication (Google sign-in) so each player can claim and manage their warband.
- Stores shared campaign state in Firestore under `campaign/current`.
- Designed to preserve the original dark ledger / ember theme.
- Installable as a PWA (Add to Home Screen) on both iOS and Android, with an offline-capable app shell.

## Files

- `index.html` — app shell, font import, PWA meta tags
- `src/styles.css` — theme and layout styling
- `src/app.js` — Firebase app logic, Auth, Firestore sync, pairing logic
- `vite.config.js` — Vite + PWA plugin config (manifest, service worker generation)
- `public/` — static assets copied as-is into the build: app icons (`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png`)
- `firebase.json` — Firebase Hosting config (serves the built `dist/` output; also sets no-cache headers on the service worker and manifest so updates roll out promptly)
- `.firebaserc` — Firebase project alias
- `firestore.rules` — Firestore security rules
- `.gitignore` — ignore local Firebase config, build output, and macOS artifacts

## Firebase setup

1. Create a Firebase project in the Firebase console.
2. Enable:
   - Authentication → Google
   - Firestore database
   - Hosting
3. In `src/app.js`, verify the `firebaseConfig` object contains your web app values:
   - `apiKey`
   - `authDomain`
   - `projectId`
   - `storageBucket`
   - `messagingSenderId`
   - `appId`
   - `measurementId` (optional)
4. In `.firebaserc`, confirm the default project id matches your Firebase project:
   ```json
   {
     "projects": {
       "default": "aos-dads-campaign"
     }
   }
   ```

## Local Firebase initialization

The project is already configured with `firebase.json`, `.firebaserc`, and `firestore.rules`.

If your environment does not allow writing to the default config directory, use a local config home:

```bash
cd /Users/loganhussung/AgeofSigmar/AoSCampaign
XDG_CONFIG_HOME=$PWD/.firebase_config npx firebase login
XDG_CONFIG_HOME=$PWD/.firebase_config npx firebase init hosting --project aos-dads-campaign
```

During `firebase init hosting`, answer:
- `What do you want to use as your public directory?` → `dist`
- `Configure as a single-page app?` → `y`
- `File dist/index.html already exists. Overwrite?` → `n` (only asked if you've already run a build)

## Development and testing

This is a [Vite](https://vitejs.dev) app. Install dependencies once, then run the dev server:

```bash
cd /Users/loganhussung/AgeofSigmar/AoSCampaign
npm install
npm run dev
```

Then visit the URL Vite prints (typically `http://localhost:5173`). The dev server has hot module reload, so edits to `src/app.js` or `src/styles.css` apply instantly.

The PWA service worker is **not** active in `npm run dev` — to test install/offline behavior, build and serve the production bundle instead:

```bash
npm run build
npm run preview
```

## Deploy

Build the production bundle, then deploy it:

```bash
cd /Users/loganhussung/AgeofSigmar/AoSCampaign
npm run build
XDG_CONFIG_HOME=$PWD/.firebase_config npx firebase deploy
```

`npm run build` outputs to `dist/`, which `firebase.json` is configured to serve.

## Git guidance

Tracked files should include:

- `index.html`
- `src/`
- `public/`
- `vite.config.js`
- `package.json`
- `firebase.json`
- `.firebaserc`
- `firestore.rules`
- `README.md`

Ignored files:

- `.DS_Store`
- `.firebase_config/`
- `node_modules/`
- `dist/`

## Notes

- The app saves campaign state to Firestore and updates in real time.
- Each player signs in with Google to claim one warband and add log entries.
- Pairings are generated with the round-robin circle method and adapt to active roster changes.
