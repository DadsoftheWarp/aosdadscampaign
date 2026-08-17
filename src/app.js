import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";

const ROOT = document.getElementById("aos-tracker-root");
const SEAL_COLORS = [
  "#c6501c",
  "#6b8f5e",
  "#3f6ea8",
  "#a8895a",
  "#8b3a3a",
  "#7a5ea8",
  "#3f8a8a",
  "#a8843f",
];
const SESSION_TEMPLATE = [
  { n: 1, phase: "Prologue", points: "Spearhead", type: "main", date: "2026-09-01" },
  { n: 2, phase: "Tier 1", points: "500 pts", type: "main", date: "2026-09-15" },
  { n: 3, phase: "Tier 1", points: "500 pts", type: "main", date: "2026-09-29" },
  { n: 4, phase: "Interlude", points: "Spearhead", type: "interlude", date: "2026-10-13" },
  { n: 5, phase: "Tier 2", points: "1000 pts", type: "main", date: "2026-10-27" },
  { n: 6, phase: "Tier 2", points: "1000 pts", type: "main", date: "2026-11-10" },
  { n: 7, phase: "Tier 3", points: "1500 pts", type: "main", date: "2026-11-24" },
  { n: 8, phase: "Interlude", points: "Spearhead", type: "interlude", date: "2026-12-08" },
  { n: 9, phase: "Tier 3", points: "1500 pts", type: "main", date: "2026-12-22" },
  { n: 10, phase: "Finale", points: "2000 pts", type: "main", date: "2027-01-05" },
  { n: 11, phase: "Finale", points: "2000 pts", type: "finale", date: "2027-01-19" },
];
const PAINT_TIERS = [500, 1000, 1500, 2000];

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const campaignDoc = doc(db, "campaign", "current");

const state = {
  tab: "standings",
  roster: [],
  schedule: [],
  entries: [],
  adminUid: null,
  adminName: "",
  user: null,
  loaded: false,
  saving: false,
  message: "",
};

let unsubscribeCampaign = null;

function uid() {
  if (window.crypto && window.crypto.randomUUID)
    return window.crypto.randomUUID();
  return (
    Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
  );
}
function playerById(id) {
  return state.roster.find((p) => p.id === id);
}
function esc(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function seal(player, sm) {
  if (!player)
    return `<span class="at-seal ${sm ? "sm" : ""}" style="background:#444">?</span>`;
  return `<span class="at-seal ${sm ? "sm" : ""}" style="background:${esc(player.color)}">${esc((player.warband || player.name || "?").slice(0, 1).toUpperCase())}</span>`;
}
function campaignDefaults() {
  return {
    roster: [],
    schedule: SESSION_TEMPLATE.map((s) => ({ ...s, note: "" })),
    entries: [],
    adminUid: null,
    adminName: "",
    updatedAt: null,
  };
}
function activePlayersFor(sessionN) {
  return state.roster.filter(
    (p) => p.active !== false && (p.joinedSession || 1) <= sessionN,
  );
}
function generateRounds(players) {
  let list = players.slice();
  if (list.length < 2) return [];
  if (list.length % 2 !== 0) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      pairs.push([a, b]);
    }
    rounds.push(pairs);
    const fixed = list[0];
    const rest = list.slice(1);
    rest.unshift(rest.pop());
    list = [fixed, ...rest];
  }
  return rounds;
}
function pairingsForSession(sessionN) {
  const session = state.schedule.find((s) => s.n === sessionN);
  if (!session || session.type !== "main") return null;
  const active = activePlayersFor(sessionN);
  const rounds = generateRounds(active.map((p) => p.id));
  if (!rounds.length) return [];
  const mainSessionsBefore =
    state.schedule.filter((x) => x.type === "main" && x.n <= sessionN)
      .length - 1;
  return rounds[mainSessionsBefore % rounds.length];
}
function resultPoints(mode, result, inStore) {
  if (result === "bye") return 3 + (inStore ? 1 : 0);
  const base = mode === "rolloff" ? 2 : 3;
  const bonus = result === "win" ? 2 : result === "draw" ? 1 : 0;
  return base + bonus;
}
function paintPoints(player) {
  const tiers = (player && player.paintedTiers) || {};
  return PAINT_TIERS.reduce((sum, t) => sum + (tiers[t] ? 1 : 0), 0);
}
function sessionCountsForPoints(sessionN) {
  const session = state.schedule.find((s) => s.n === sessionN);
  if (!session) return true;
  if (session.type === "interlude") return false;
  if (session.phase === "Prologue") return false;
  return true;
}
function nextSessionInfo() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = state.schedule
    .filter((s) => s.date)
    .map((s) => ({ session: s, d: new Date(`${s.date}T00:00:00`) }))
    .filter((x) => !isNaN(x.d) && x.d >= today)
    .sort((a, b) => a.d - b.d);
  return upcoming.length ? upcoming[0].session : null;
}
function computeStandings() {
  const map = {};
  state.roster.forEach((p) => {
    const paint = paintPoints(p);
    map[p.id] = {
      player: p,
      points: paint,
      paint,
      gamePts: 0,
      byePts: 0,
      w: 0,
      d: 0,
      l: 0,
      honours: 0,
    };
  });
  state.entries.forEach((e) => {
    const countsForPoints = sessionCountsForPoints(e.sessionN);
    (e.results || []).forEach((r) => {
      if (!map[r.playerId]) return;
      if (countsForPoints) {
        const pts = resultPoints(e.mode, r.result, r.inStore);
        map[r.playerId].points += pts;
        if (r.result === "bye") map[r.playerId].byePts += pts;
        else map[r.playerId].gamePts += pts;
      }
      if (r.result === "win") map[r.playerId].w++;
      else if (r.result === "draw") map[r.playerId].d++;
      else if (r.result === "loss") map[r.playerId].l++;
    });
    (e.honours || []).forEach((h) => {
      if (map[h.playerId]) map[h.playerId].honours++;
    });
  });
  return Object.values(map).sort(
    (a, b) => b.points - a.points || b.honours - a.honours,
  );
}

function render() {
  if (!state.loaded) {
    ROOT.innerHTML = `<div class="at-loading">Connecting to campaign data…</div>`;
    return;
  }

  const next = nextSessionInfo();

  ROOT.innerHTML = `
    <div class="at-app-shell">
      <div class="at-header">
        <div class="at-header-group">
          <p class="at-eyebrow">Fall & Winter Escalation Season</p>
          <h1 class="at-title">The Mortal Realms <span>Campaign Ledger</span></h1>
          <p class="at-section-sub">Firebase-backed campaign data with Google sign-in for each player.</p>
          ${
            next
              ? `<p class="at-next-session">Next up: Session ${next.n} — ${esc(next.phase)} (${esc(next.points)}) · ${esc(next.date)}</p>`
              : ""
          }
        </div>
        <div class="at-auth-bar">
          <div class="at-auth-actions">
            ${state.user ? `<span class="at-user-chip">${esc(state.user.displayName || state.user.email)}</span><button class="at-btn secondary" id="sign-out">Sign out</button>` : `<button class="at-btn" id="sign-in">Sign in with Google</button>`}
          </div>
          ${state.saving ? '<p class="at-message">Saving changes…</p>' : ""}
          ${state.message ? `<p class="at-message">${state.message}</p>` : ""}
        </div>
      </div>
      <div class="at-nav">
        ${["standings", "roster", "schedule", "log"]
          .map(
            (tab) => `
          <button class="${state.tab === tab ? "active" : ""}" data-tab="${tab}">${tab === "standings" ? "Standings" : tab === "roster" ? "Roster" : tab === "schedule" ? "Schedule & Pairings" : "Campaign Log"}</button>
        `,
          )
          .join("")}
      </div>
      <div class="at-body" id="at-body"></div>
    </div>
  `;

  document.getElementById("sign-in")?.addEventListener("click", signIn);
  document.getElementById("sign-out")?.addEventListener("click", signOutUser);

  ROOT.querySelectorAll(".at-nav button").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      render();
    });
  });

  const body = document.getElementById("at-body");
  if (state.tab === "standings") body.innerHTML = renderStandings();
  if (state.tab === "roster") body.innerHTML = renderRoster();
  if (state.tab === "schedule") body.innerHTML = renderSchedule();
  if (state.tab === "log") body.innerHTML = renderLog();

  if (state.tab === "roster") wireRoster();
  if (state.tab === "schedule") wireSchedule();
  if (state.tab === "log") wireLog();
}

function renderStandings() {
  const rows = computeStandings();
  if (!state.roster.length)
    return `<div class="at-empty">No warbands yet. Add players on the Roster tab to start tracking standings.</div>`;
  return `
    <p class="at-section-title">Campaign Standings</p>
    <p class="at-section-sub">Game: 3 pts (2 for a roll-off) + win 2 / draw 1 / loss 0. Bye: 3 pts, +1 if in-store. Painting: +1 per escalation size fully painted, up to 4. Spearhead sessions (Prologue & Interludes) don't count toward campaign points.</p>
    <div class="at-card" style="padding:0; overflow-x:auto;">
      <table class="at-table">
        <thead><tr>
          <th>Warband</th>
          <th class="num">W</th>
          <th class="num">D</th>
          <th class="num">L</th>
          <th class="num">Honours</th>
          <th class="num">Paint</th>
          <th class="num">Camp. Pts</th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (row, idx) => `
            <tr>
              <td>
                <div style="display:flex;align-items:center;gap:10px;">
                  ${seal(row.player)}
                  <details class="at-standings-detail">
                    <summary class="${idx === 0 ? "at-rank1" : ""}">${esc(row.player.warband || row.player.name)}</summary>
                    <div class="at-standings-breakdown">Games: ${row.gamePts} pts · Byes: ${row.byePts} pts · Painting: ${row.paint} pts</div>
                  </details>
                </div>
              </td>
              <td class="num">${row.w}</td>
              <td class="num">${row.d}</td>
              <td class="num">${row.l}</td>
              <td class="num">${row.honours}</td>
              <td class="num">${row.paint}/${PAINT_TIERS.length}</td>
              <td class="num ${idx === 0 ? "at-rank1" : ""}">${row.points}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderRoster() {
  const ownedWarband = state.user
    ? state.roster.find((p) => p.ownerUid === state.user.uid)
    : null;
  const isAdmin = !!state.user && state.user.uid === state.adminUid;
  const otherOwners = state.roster
    .filter((p) => p.ownerUid && p.ownerUid !== state.user?.uid)
    .filter(
      (p, i, arr) => arr.findIndex((x) => x.ownerUid === p.ownerUid) === i,
    );
  const paidCount = state.roster.filter((p) => p.paidEntryFee).length;
  const fullyPaintedCount = state.roster.filter(
    (p) => paintPoints(p) === PAINT_TIERS.length,
  ).length;
  return `
    <p class="at-section-title">Roster</p>
    <p class="at-section-sub">Each player should sign in with Google to claim a warband and track campaign results.${ownedWarband ? " You can update your details below any time." : ""}</p>
    ${!state.user ? '<div class="at-empty">Sign in to claim a warband and manage your campaign profile.</div>' : ""}
    <div class="at-card">
      <div class="at-row">
        <div class="at-field"><label>Player name</label><input id="rp-name" placeholder="Alex" value="${esc(ownedWarband?.name || "")}" ${!state.user ? "disabled" : ""}/></div>
        <div class="at-field"><label>Warband name</label><input id="rp-warband" placeholder="The Blackspire Vigil" value="${esc(ownedWarband?.warband || "")}" ${!state.user ? "disabled" : ""}/></div>
        <div class="at-field"><label>Faction</label><input id="rp-faction" placeholder="Stormcast Eternals" value="${esc(ownedWarband?.faction || "")}" ${!state.user ? "disabled" : ""}/></div>
        <div class="at-field"><label>Joins at session</label><input id="rp-joins" type="number" min="1" max="12" value="${ownedWarband?.joinedSession || 1}" style="min-width:82px" ${!state.user ? "disabled" : ""}/></div>
        <button class="at-btn" id="rp-add" ${!state.user ? "disabled" : ""}>${ownedWarband ? "Save changes" : "Claim my warband"}</button>
      </div>
    </div>
    ${
      state.user
        ? `<div class="at-card" style="padding:12px 16px;">
      <div class="at-row" style="align-items:center;">
        <div class="at-field" style="flex:1;min-width:220px;">
          <label>Campaign admin</label>
          <div style="font-size:13px;">${
            state.adminUid
              ? esc(state.adminName || "Unknown") + (isAdmin ? " (you)" : "")
              : "Not yet assigned"
          }</div>
        </div>
        ${!state.adminUid ? `<button class="at-btn secondary" id="admin-claim">Become campaign admin</button>` : ""}
        ${isAdmin ? `<button class="at-btn danger" id="admin-step-down">Step down</button>` : ""}
        ${
          isAdmin && otherOwners.length
            ? `<div class="at-field">
                <label>Transfer to</label>
                <select id="admin-transfer-target">
                  ${otherOwners.map((p) => `<option value="${esc(p.ownerUid)}">${esc(p.ownerName || p.name)}</option>`).join("")}
                </select>
              </div>
              <button class="at-btn secondary" id="admin-transfer">Transfer</button>`
            : ""
        }
      </div>
      <p class="at-section-sub" style="margin:6px 0 0;">Only the campaign admin can mark an army's escalation tiers as fully painted and confirm entry fee payment, decided by group vote in person.</p>
      ${
        state.roster.length
          ? `<p class="at-section-sub" style="margin:4px 0 0;">Entry fees: ${paidCount}/${state.roster.length} paid · Painting: ${fullyPaintedCount}/${state.roster.length} fully painted (${PAINT_TIERS.length}/${PAINT_TIERS.length} tiers)</p>`
          : ""
      }
    </div>`
        : ""
    }
    <div class="at-card">
      ${
        state.roster.length
          ? state.roster
              .map(
                (p) => `
        <div class="at-player-row">
          ${seal(p)}
          <div class="at-player-info">
            <div class="at-player-name">${esc(p.warband || p.name)} <span class="at-tag ${p.active !== false ? "active" : "inactive"}">${p.active !== false ? "active" : "inactive"}</span><span class="at-tag ${p.paidEntryFee ? "active" : "inactive"}">${p.paidEntryFee ? "paid" : "unpaid"}</span></div>
            <div class="at-player-meta">${esc(p.name)} • ${esc(p.faction || "faction not set")} • joins session ${p.joinedSession || 1} • ${p.ownerUid ? (p.ownerUid === state.user?.uid ? "you" : "player account") : "unclaimed"}</div>
            <div class="at-paint-tiers">
              <span>Painted:</span>
              ${PAINT_TIERS.map(
                (t) => `
                <label class="at-checkline">
                  <input type="checkbox" data-paint="${p.id}" data-tier="${t}" ${p.paintedTiers?.[t] ? "checked" : ""} ${isAdmin ? "" : "disabled"} />
                  ${t}
                </label>
              `,
              ).join("")}
            </div>
            <div class="at-paint-tiers">
              <span>Entry fee:</span>
              <label class="at-checkline">
                <input type="checkbox" data-paid="${p.id}" ${p.paidEntryFee ? "checked" : ""} ${isAdmin ? "" : "disabled"} />
                Paid
              </label>
            </div>
          </div>
          ${p.ownerUid === state.user?.uid ? `<button class="at-btn secondary" data-toggle="${p.id}">${p.active !== false ? "Mark inactive" : "Mark active"}</button>` : ""}
          ${p.ownerUid === state.user?.uid ? `<button class="at-btn danger" data-remove="${p.id}">Remove</button>` : ""}
        </div>
      `,
              )
              .join("")
          : '<div class="at-empty">No warbands added yet.</div>'
      }
    </div>
  `;
}

function renderSchedule() {
  return `
    <p class="at-section-title">Schedule & Pairings</p>
    <p class="at-section-sub">Pairings auto-generate from your active roster using a round-robin rotation. Update real session dates as you go.</p>
    ${
      state.user
        ? `<div class="at-row" style="margin-bottom:10px;"><button class="at-btn secondary" id="sched-reset">Reset schedule to template</button></div>`
        : ""
    }
    <div class="at-card" style="padding:6px 12px;">
      ${state.schedule
        .map((session) => {
          let pairText = "";
          if (session.type === "main") {
            const pairs = pairingsForSession(session.n);
            if (pairs && pairs.length) {
              pairText = pairs
                .map(([a, b]) => {
                  const pa = playerById(a);
                  const pb = playerById(b);
                  if (!pb) return `${esc(pa ? pa.warband || pa.name : "?")} — BYE`;
                  return `${esc(pa.warband || pa.name)} vs ${esc(pb.warband || pb.name)}`;
                })
                .join(" &nbsp;|&nbsp; ");
            } else {
              pairText = "Add 2+ active players to generate pairings";
            }
          } else if (session.type === "interlude") {
            pairText =
              "Flexible — free-for-all, army try-outs, or onboarding new players";
          } else {
            pairText =
              "Campaign finale — pick the matchup that tells the best story";
          }
          return `
          <div class="at-sched-row">
            <div class="at-sched-n">${session.n}</div>
            <div>
              <span class="at-pill ${session.type}">${session.type}</span>
              <div class="at-sched-phase">${esc(session.phase)}</div>
            </div>
            <div class="at-sched-points">${esc(session.points)}</div>
            <div class="at-sched-pairs">${pairText}</div>
            <div class="at-sched-date"><input data-date="${session.n}" type="text" placeholder="date" value="${esc(session.date || "")}" /></div>
          </div>
        `;
        })
        .join("")}
    </div>
  `;
}

function renderLog() {
  const sorted = state.entries
    .slice()
    .sort((a, b) => b.sessionN - a.sessionN || b.createdAt - a.createdAt);
  if (!state.user) {
    return `
      <p class="at-section-title">Campaign Log</p>
      <p class="at-section-sub">Sign in to add your session results and narrative entries.</p>
      <div class="at-empty">View standings while signed out, then sign in to track your own warband and add campaign entries.</div>
    `;
  }
  return `
    <p class="at-section-title">Campaign Log & Warband Journals</p>
    <p class="at-section-sub">Log game results, Battle Honours, and narrative notes here. Standings are derived automatically.</p>
    <div class="at-card">
      <div class="at-row">
        <div class="at-field"><label>Session</label>
          <select id="le-session">
            ${state.schedule
              .map(
                (s) =>
                  `<option value="${s.n}">Session ${s.n} — ${esc(s.phase)} (${esc(s.points)})${s.date ? " · " + esc(s.date) : ""}</option>`,
              )
              .join("")}
          </select>
        </div>
        <div class="at-field"><label>Entry type</label>
          <select id="le-type">
            <option value="game">Game result</option>
            <option value="journal">Narrative note</option>
          </select>
        </div>
        <div class="at-field"><label>Game mode</label>
          <select id="le-mode">
            <option value="game">Normal game</option>
            <option value="rolloff">Roll-off</option>
          </select>
        </div>
        <div class="at-field" style="flex:1;min-width:200px;"><label>Title</label><input id="le-title" placeholder="The Battle for Blackspire Ruins" /></div>
      </div>
      <p class="at-section-sub" style="margin:6px 0 0;">Spearhead sessions (Prologue & Interludes, see Schedule tab) don't count toward campaign points.</p>
      <div class="at-row" style="margin-top:12px;">
        <div class="at-field" style="flex:1;"><label>Narrative</label><textarea id="le-body" placeholder="What happened, in a few sentences..."></textarea></div>
      </div>
      <div class="at-row" style="margin-top:12px;" id="le-results-wrap">
        <div class="at-field">
          <label>Participants & results (game entries) — click a name to cycle win / draw / loss / bye</label>
          <p class="at-section-sub" id="le-suggest-note" style="margin:2px 0 8px;"></p>
          <div class="at-multi-select" id="le-participants"></div>
        </div>
      </div>
      <div class="at-row" style="margin-top:12px;">
        <div class="at-field" style="flex:1;"><label>Battle Honour (optional, pick a player above)</label><input id="le-honour" placeholder="e.g. Lord-Vigilant slew their general in a duel" /></div>
      </div>
      <div class="at-row" style="margin-top:14px;">
        <button class="at-btn" id="le-add">Add to Ledger</button>
      </div>
    </div>

    <div>
      ${
        sorted.length
          ? sorted
              .map((entry) => {
                const countsForPoints = sessionCountsForPoints(
                  entry.sessionN,
                );
                return `
        <div class="at-entry">
          <div class="at-entry-head">
            <span class="at-entry-session">SESSION ${entry.sessionN}${countsForPoints ? "" : " · SPEARHEAD (no points)"}</span>
            <span class="at-entry-title">${esc(entry.title || "Untitled")}</span>
          </div>
          <div class="at-entry-body">${esc(entry.body || "")}</div>
          ${
            entry.results && entry.results.length
              ? `<div class="at-entry-results">${entry.results
                  .map(
                    (r) => `
              <span class="at-result-chip">${seal(playerById(r.playerId), true)} ${esc(playerById(r.playerId) ? playerById(r.playerId).warband || playerById(r.playerId).name : "?")} <span class="r ${r.result}">${r.result}${r.result === "bye" && r.inStore ? " · in-store" : ""} · ${countsForPoints ? resultPoints(entry.mode, r.result, r.inStore) : 0}pt</span></span>
            `,
                  )
                  .join("")}</div>`
              : ""
          }
          ${entry.honours && entry.honours.length ? entry.honours.map((h) => `<div class="at-honour">⚔ ${esc(playerById(h.playerId) ? playerById(h.playerId).warband || playerById(h.playerId).name : "?")} — ${esc(h.text)}</div>`).join("") : ""}
          <div class="at-entry-body" style="margin-top:10px;font-size:12px;color:var(--text-muted);">Added by ${esc(entry.authorName || "unknown")}${entry.authorUid === state.user.uid ? " • you" : ""}</div>
          ${entry.authorUid === state.user.uid ? `<div style="margin-top:8px;"><button class="at-btn danger" data-del="${entry.id}">Delete entry</button></div>` : ""}
        </div>
      `;
              })
              .join("")
          : '<div class="at-empty">No log entries yet. Add your first session write-up above.</div>'
      }
    </div>
  `;
}

function wireRoster() {
  document.getElementById("rp-add")?.addEventListener("click", async () => {
    const name = document.getElementById("rp-name").value.trim();
    const warband = document.getElementById("rp-warband").value.trim();
    const faction = document.getElementById("rp-faction").value.trim();
    const joins = parseInt(document.getElementById("rp-joins").value, 10) || 1;
    if (!name || !warband) {
      alert("Please add both a player name and a warband name.");
      return;
    }
    const existing = state.roster.find((p) => p.ownerUid === state.user.uid);
    if (existing) {
      existing.name = name;
      existing.warband = warband;
      existing.faction = faction;
      existing.joinedSession = joins;
    } else {
      state.roster.push({
        id: uid(),
        name,
        warband,
        faction,
        joinedSession: joins,
        active: true,
        color: SEAL_COLORS[state.roster.length % SEAL_COLORS.length],
        ownerUid: state.user.uid,
        ownerName: state.user.displayName || "",
      });
    }
    await saveCampaign();
  });

  document
    .getElementById("admin-claim")
    ?.addEventListener("click", async () => {
      state.adminUid = state.user.uid;
      state.adminName = state.user.displayName || state.user.email || "";
      await saveCampaign();
    });

  document
    .getElementById("admin-step-down")
    ?.addEventListener("click", async () => {
      if (!confirm("Step down as campaign admin? Nobody will be able to mark armies as painted or confirm entry fees until someone claims the role.")) return;
      state.adminUid = null;
      state.adminName = "";
      await saveCampaign();
    });

  document
    .getElementById("admin-transfer")
    ?.addEventListener("click", async () => {
      const select = document.getElementById("admin-transfer-target");
      if (!select || !select.value) return;
      const target = state.roster.find((p) => p.ownerUid === select.value);
      state.adminUid = select.value;
      state.adminName = target?.ownerName || target?.name || "";
      await saveCampaign();
    });

  ROOT.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const player = playerById(btn.dataset.toggle);
      if (!player) return;
      player.active = player.active === false ? true : false;
      await saveCampaign();
    });
  });

  ROOT.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (
        !confirm(
          "Remove this warband from the roster? Past log entries will keep their record.",
        )
      )
        return;
      state.roster = state.roster.filter((p) => p.id !== btn.dataset.remove);
      await saveCampaign();
    });
  });

  ROOT.querySelectorAll("[data-paint]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const player = playerById(checkbox.dataset.paint);
      if (!player) return;
      player.paintedTiers = player.paintedTiers || {};
      player.paintedTiers[checkbox.dataset.tier] = checkbox.checked;
      await saveCampaign();
    });
  });

  ROOT.querySelectorAll("[data-paid]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const player = playerById(checkbox.dataset.paid);
      if (!player) return;
      player.paidEntryFee = checkbox.checked;
      await saveCampaign();
    });
  });
}

function wireSchedule() {
  document.getElementById("sched-reset")?.addEventListener("click", async () => {
    if (
      !confirm(
        "Reset the schedule to the current template? This restores the default session phases, points, types, and dates — any custom dates or notes you've entered will be overwritten.",
      )
    )
      return;
    state.schedule = campaignDefaults().schedule;
    await saveCampaign();
  });

  ROOT.querySelectorAll("[data-date]").forEach((input) => {
    input.addEventListener("change", async () => {
      const session = state.schedule.find(
        (s) => s.n === Number(input.dataset.date),
      );
      if (!session) return;
      session.date = input.value;
      await saveCampaign();
    });
  });
}

function wireLog() {
  const participantWrap = document.getElementById("le-participants");
  if (!participantWrap) return; // signed out — renderLog() shows no form to wire up
  const suggestNote = document.getElementById("le-suggest-note");
  const selected = {};
  let suggestedPair = [];

  function updateSuggestedPairing() {
    suggestedPair = [];
    if (suggestNote) suggestNote.textContent = "";
    const sessionSelect = document.getElementById("le-session");
    const typeSelect = document.getElementById("le-type");
    if (!sessionSelect || !typeSelect || typeSelect.value !== "game") return;
    const sessionN = parseInt(sessionSelect.value, 10);
    const myPlayer = state.roster.find(
      (p) => p.ownerUid === state.user?.uid,
    );
    if (!myPlayer) return;
    const pairs = pairingsForSession(sessionN);
    if (!pairs) return;
    const myPair = pairs.find(([a, b]) => a === myPlayer.id || b === myPlayer.id);
    if (!myPair) return;
    suggestedPair = myPair.filter(Boolean);
    if (!suggestNote) return;
    if (suggestedPair.length === 1) {
      suggestNote.textContent =
        "You have a bye this session — click your name below and mark it bye.";
    } else {
      const [a, b] = suggestedPair;
      const pa = playerById(a);
      const pb = playerById(b);
      suggestNote.textContent = `Suggested pairing: ${pa?.warband || pa?.name} vs ${pb?.warband || pb?.name} — click below to log results.`;
    }
  }

  function renderParticipants() {
    const ordered = state.roster.slice().sort((a, b) => {
      const aSug = suggestedPair.includes(a.id) ? 0 : 1;
      const bSug = suggestedPair.includes(b.id) ? 0 : 1;
      return aSug - bSug;
    });
    participantWrap.innerHTML = ordered
      .map((p) => {
        const sel = selected[p.id];
        const label = sel
          ? sel.result === "bye"
            ? `bye${sel.inStore ? " · in-store" : ""}`
            : sel.result
          : "";
        const isSuggested = suggestedPair.includes(p.id);
        return `
      <span class="at-chip-toggle ${sel ? "on" : ""} ${isSuggested ? "suggested" : ""}" data-pid="${p.id}">
        ${esc(p.warband || p.name)} ${label ? "· " + esc(label) : ""}
        ${isSuggested && !sel ? '<span class="at-chip-hint">suggested</span>' : ""}
        ${sel && sel.result === "bye" ? `<button type="button" class="at-chip-substoggle" data-instore="${p.id}">${sel.inStore ? "✓ in-store" : "+ in-store"}</button>` : ""}
      </span>
    `;
      })
      .join("");
    participantWrap.querySelectorAll("[data-pid]").forEach((chip) => {
      chip.addEventListener("click", (evt) => {
        if (evt.target.closest("[data-instore]")) return;
        const pid = chip.dataset.pid;
        const cycle = [undefined, "win", "draw", "loss", "bye"];
        const current = cycle.indexOf(selected[pid]?.result);
        const next = cycle[(current + 1) % cycle.length];
        if (next === undefined) delete selected[pid];
        else selected[pid] = { result: next, inStore: false };
        renderParticipants();
      });
    });
    participantWrap.querySelectorAll("[data-instore]").forEach((btn) => {
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const pid = btn.dataset.instore;
        if (selected[pid]) selected[pid].inStore = !selected[pid].inStore;
        renderParticipants();
      });
    });
  }
  updateSuggestedPairing();
  renderParticipants();

  document.getElementById("le-session")?.addEventListener("change", () => {
    updateSuggestedPairing();
    renderParticipants();
  });
  document.getElementById("le-type")?.addEventListener("change", () => {
    updateSuggestedPairing();
    renderParticipants();
  });

  document.getElementById("le-add")?.addEventListener("click", async () => {
    const sessionN =
      parseInt(document.getElementById("le-session").value, 10) || 1;
    const kind = document.getElementById("le-type").value;
    const mode = document.getElementById("le-mode").value;
    const title = document.getElementById("le-title").value.trim();
    const body = document.getElementById("le-body").value.trim();
    const honourText = document.getElementById("le-honour").value.trim();
    if (!title && !body) {
      alert("Add at least a title or a narrative note.");
      return;
    }
    const results = [];
    if (kind === "game") {
      Object.entries(selected).forEach(([playerId, sel]) => {
        results.push({
          playerId,
          result: sel.result,
          inStore: sel.result === "bye" ? !!sel.inStore : false,
        });
      });
    }
    if (kind === "game" && results.length) {
      const nonBye = results.filter((r) => r.result !== "bye");
      const wins = nonBye.filter((r) => r.result === "win").length;
      const losses = nonBye.filter((r) => r.result === "loss").length;
      const draws = nonBye.filter((r) => r.result === "draw").length;
      if (nonBye.length === 2) {
        const validWinLoss = wins === 1 && losses === 1 && draws === 0;
        const validDraw = draws === 2;
        if (!validWinLoss && !validDraw) {
          alert(
            "Results don't add up: mark exactly one player win and the other loss, or mark both as a draw.",
          );
          return;
        }
      } else if (nonBye.length === 1) {
        if (
          !confirm(
            "Only one player has a win/draw/loss result — did you forget to mark the opponent? Continue anyway?",
          )
        )
          return;
      }
      const newIds = new Set(results.map((r) => r.playerId));
      const duplicate = state.entries.some(
        (e) =>
          e.kind === "game" &&
          e.sessionN === sessionN &&
          (e.results || []).some((r) => newIds.has(r.playerId)),
      );
      if (duplicate) {
        if (
          !confirm(
            `A game result for Session ${sessionN} involving one of these players has already been logged. Add this entry anyway?`,
          )
        )
          return;
      }
    }
    const honours = [];
    if (honourText) {
      const firstSelected = Object.keys(selected)[0];
      if (firstSelected)
        honours.push({ playerId: firstSelected, text: honourText });
    }
    state.entries.push({
      id: uid(),
      sessionN,
      createdAt: Date.now(),
      kind,
      mode,
      title,
      body,
      results,
      honours,
      authorUid: state.user.uid,
      authorName: state.user.displayName || state.user.email || "Player",
    });
    await saveCampaign();
  });

  ROOT.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this log entry?")) return;
      state.entries = state.entries.filter(
        (entry) => entry.id !== btn.dataset.del,
      );
      await saveCampaign();
    });
  });
}

function setMessage(text) {
  state.message = text;
  render();
}

async function saveCampaign() {
  state.saving = true;
  setMessage("");
  render();
  try {
    await setDoc(
      campaignDoc,
      {
        roster: state.roster,
        schedule: state.schedule,
        entries: state.entries,
        adminUid: state.adminUid,
        adminName: state.adminName,
        updatedAt: serverTimestamp(),
        lastModifiedBy: state.user?.uid || null,
      },
      { merge: true },
    );
    state.saving = false;
    setMessage("Campaign data saved.");
  } catch (error) {
    console.error("Failed to save campaign", error);
    state.saving = false;
    setMessage(
      "Unable to save campaign data. Check your Firebase config and permissions.",
    );
  }
}

async function initCampaign() {
  try {
    const snapshot = await getDoc(campaignDoc);
    if (!snapshot.exists()) {
      await setDoc(campaignDoc, {
        ...campaignDefaults(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    if (unsubscribeCampaign) unsubscribeCampaign();
    unsubscribeCampaign = onSnapshot(
      campaignDoc,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data();
        state.roster = Array.isArray(data.roster) ? data.roster : [];
        state.schedule = Array.isArray(data.schedule)
          ? data.schedule
          : campaignDefaults().schedule;
        state.entries = Array.isArray(data.entries) ? data.entries : [];
        state.adminUid = data.adminUid || null;
        state.adminName = data.adminName || "";
        state.loaded = true;
        render();
      },
      (error) => {
        console.error("Campaign snapshot failed", error);
        state.loaded = true;
        setMessage(
          "Unable to load campaign data. Confirm Firebase rules allow reads.",
        );
        render();
      },
    );
  } catch (error) {
    console.error("Unable to initialize campaign data", error);
    state.loaded = true;
    setMessage(
      "Unable to connect to Firestore. Fill Firebase config and enable Firestore.",
    );
    render();
  }
}

async function signIn() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
    setMessage("Signed in successfully.");
  } catch (error) {
    console.error("Sign in failed", error);
    setMessage("Google sign-in failed. Please try again.");
  }
}

async function signOutUser() {
  try {
    await signOut(auth);
    setMessage("Signed out.");
  } catch (error) {
    console.error("Sign out failed", error);
    setMessage("Unable to sign out.");
  }
}

function initAuth() {
  onAuthStateChanged(auth, (user) => {
    state.user = user;
    if (!unsubscribeCampaign) {
      initCampaign();
    } else {
      render();
    }
  });
}

initAuth();
