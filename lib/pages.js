'use strict';

// HTML for each page. Every value from data or the user goes through esc().

const { sprite, icon } = require('./icons');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MARK = '<img class="logo" src="/static/logo.png" alt="" width="64" height="64">';

function header(config, nav) {
  return `
<header class="site-header">
  <div class="utility">
    <a href="/">${icon('board', 'icon sm')}Status Board</a>
    <a href="/nurse">${icon('cross', 'icon sm')}Nurse Page</a>
  </div>
  <div class="brand-row">
    <a class="brand" href="/">
      ${MARK}
      <span class="brand-text">
        <span class="school">${esc(config.schoolName || config.title)}</span>
        <span class="tagline">${esc(config.title)} Status Board</span>
      </span>
    </a>
    <nav class="main-nav">${nav}</nav>
  </div>
</header>`;
}

function layout({ config, title, bodyClass = '', csrf = '', nav = '', inner, withHeader = true }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csrf ? `<meta name="csrf-token" content="${esc(csrf)}">` : ''}
<title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/static/logo.png">
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body class="${esc(bodyClass)}">
${sprite()}
${withHeader && config ? header(config, nav) : ''}
${inner}
</body>
</html>`;
}

const signInLink = '<a class="btn-signin" href="/nurse">Sign in</a>';
const signOutButton = '<button type="button" id="logout" class="btn-signin">Sign out</button>';

function extraText(v) {
  return [v.backAt ? 'back at ' + v.backAt : '', v.note ? `"${v.note}"` : ''].filter(Boolean).join(' - ');
}

function boardPage(config, v, embed) {
  const inner = `
<main class="board-wrap">
  <section id="board" class="status-tile s-${esc(v.color)}" data-title="${esc(config.title)}" aria-live="polite">
    <p class="eyebrow">${esc(config.title)}</p>
    <h1 id="label">${esc(v.label)}</h1>
    <p id="backAt" class="back"${v.backAt ? '' : ' hidden'}>Back at <span id="backTime">${esc(v.backAt)}</span></p>
    <p id="note" class="note"${v.note ? '' : ' hidden'}>${esc(v.note)}</p>
    <p class="meta" id="updated">${esc(v.updated)}</p>
  </section>
  <p id="offline" class="offline" hidden>Can't reach the status board right now. Showing the last known status.</p>
  <p class="emergency">${icon('phone', 'icon')}<span>${esc(config.emergencyNote)}</span></p>
  ${config.contactEmail ? `<p class="contact">${icon('mail', 'icon')}<span>Email the nurse: <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a></span></p>` : ''}
  ${embed ? '<p class="embed-link"><a href="/" target="_blank" rel="noopener">Open the board in its own tab</a></p>' : ''}
</main>`;
  return layout({
    config, title: `${v.label} - ${config.title}`, bodyClass: embed ? 'board embed' : 'board',
    nav: signInLink, inner, withHeader: !embed,
  });
}

function loginPage(config) {
  const inner = `
<main class="card-page">
  <section class="card">
    <h1>Nurse sign-in</h1>
    <p class="muted">Sign in to update the ${esc(config.title.toLowerCase())} status.</p>
    <p id="formError" class="flash error" role="alert" hidden></p>
    <form id="loginForm" class="stack" novalidate>
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" required>
      <button type="submit" class="btn-primary">Sign in</button>
    </form>
    <p class="muted small">Forgot your password? Ask the school admin to reset it.</p>
  </section>
</main>`;
  return layout({ config, title: `Sign in - ${config.title}`, bodyClass: 'control', nav: '', inner });
}

function controlPage(config, v, csrf, email) {
  const tiles = config.statuses.map(s =>
    `      <button type="button" class="tile c-${esc(s.color)}${s.key === v.key ? ' current' : ''}" data-key="${esc(s.key)}">` +
    `${icon(s.icon, 'tile-icon')}<span class="tile-label">${esc(s.label)}</span></button>`
  ).join('\n');
  const inner = `
<main class="card-page wide">
  <section class="card">
    <h1>Set your status</h1>
    <p class="muted small">Signed in as ${esc(email)}</p>
    <p class="current"><span id="dot" class="dot s-${esc(v.color)}"></span> Now showing: <strong id="cur">${esc(v.label)}</strong>
      <span id="curExtra" class="muted">${esc(extraText(v))}</span></p>
    <p id="flash" class="flash" role="status" hidden></p>

    <div class="row">
      <div>
        <label for="backAt">Back at (optional)</label>
        <input id="backAt" type="time">
      </div>
      <div class="grow">
        <label for="note">Note (optional)</label>
        <input id="note" type="text" maxlength="140" placeholder="e.g. Covering at the high school">
      </div>
    </div>
    <p class="muted small">Fill these in first if you want, then tap a status.</p>

    <div id="buttons" class="tiles" data-cooldown="${Number(config.cooldownSeconds) || 5}">
${tiles}
    </div>
  </section>

  <nav class="pill-links" aria-label="More">
    <a class="pill" href="/" target="_blank" rel="noopener">${icon('board', 'icon')}View the status board</a>
    <a class="pill alt" href="/nurse/history.csv">${icon('history', 'icon')}Download history</a>
    <a class="pill" href="/nurse/password">${icon('key', 'icon')}Change password</a>
  </nav>
</main>`;
  return layout({ config, title: `Set status - ${config.title}`, bodyClass: 'control', csrf, nav: signOutButton, inner });
}

function passwordPage(config, csrf, email) {
  const inner = `
<main class="card-page">
  <section class="card">
    <h1>Change password</h1>
    <p class="muted small">Signed in as ${esc(email)}</p>
    <p id="formError" class="flash error" role="alert" hidden></p>
    <p id="formOk" class="flash ok" role="status" hidden></p>
    <form id="passwordForm" class="stack" novalidate>
      <label for="current">Current password</label>
      <input id="current" type="password" autocomplete="current-password" required>
      <label for="next">New password</label>
      <input id="next" type="password" autocomplete="new-password" minlength="10" required>
      <p class="muted small hint">At least 10 characters. A short phrase is easy to remember, like <i>purple-lunch-tray-42</i>.</p>
      <label for="confirm">Type the new password again</label>
      <input id="confirm" type="password" autocomplete="new-password" required>
      <button type="submit" class="btn-primary">Change password</button>
    </form>
    <p class="muted small">Changing it signs you out on every other computer.</p>
    <p class="small"><a href="/nurse">&larr; Back to status</a></p>
  </section>
</main>`;
  return layout({ config, title: `Change password - ${config.title}`, bodyClass: 'control', csrf, nav: signOutButton, inner });
}

function setupPage(problems) {
  const inner = `
<main class="card-page">
  <section class="card">
    <h1>Setup needed</h1>
    <p>The status board isn't configured yet. In Vercel: <b>Settings &rarr; Environment Variables</b>, then redeploy.</p>
    <ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
  </section>
</main>`;
  return layout({ title: 'Setup needed', bodyClass: 'control', inner, withHeader: false });
}

module.exports = { boardPage, loginPage, controlPage, passwordPage, setupPage };
