// Browser side: board auto-refresh, sign-in, status buttons, sign-out and change password.
(function () {
  'use strict';

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';
  function $(id) { return document.getElementById(id); }
  function show(el, text) { el.textContent = text || ''; el.hidden = !text; }

  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && path !== '/api/login') {
          location.href = '/nurse';
          throw new Error('Signed out.');
        }
        if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
        return data;
      });
    });
  }

  // ---- public board: refresh every 15 seconds ----
  var board = $('board');
  if (board) {
    var colors = ['green', 'amber', 'red', 'blue', 'gray'];
    var eyebrow = board.getAttribute('data-title');
    var poll = function () {
      fetch('/api/status', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (s) {
          colors.forEach(function (c) { board.classList.remove('s-' + c); });
          board.classList.add('s-' + s.color);
          $('label').textContent = s.label;
          $('backTime').textContent = s.backAt;
          $('backAt').hidden = !s.backAt;
          show($('note'), s.note);
          $('updated').textContent = s.updated;
          document.title = s.label + ' - ' + eyebrow;
          $('offline').hidden = true;
        })
        .catch(function () { $('offline').hidden = false; })
        .then(function () { setTimeout(poll, 15000); });
    };
    setTimeout(poll, 15000);
  }

  // ---- sign in ----
  var loginForm = $('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = loginForm.querySelector('button');
      var email = $('email').value.trim();
      var password = $('password').value;
      if (!email || !password) { show($('formError'), 'Enter your email and password.'); return; }
      btn.disabled = true;
      btn.textContent = 'Signing in...';
      show($('formError'), '');
      api('/api/login', { email: email, password: password })
        .then(function () { location.href = '/nurse'; })
        .catch(function (err) {
          show($('formError'), err.message);
          btn.disabled = false;
          btn.textContent = 'Sign in';
          $('password').value = '';
          $('password').focus();
        });
    });
  }

  // ---- status buttons: one tap = one change, then a short wait ----
  var box = $('buttons');
  if (box) {
    var buttons = Array.prototype.slice.call(box.querySelectorAll('button[data-key]'));
    var cooldown = Number(box.getAttribute('data-cooldown')) || 5;
    var busy = false;
    var flash = $('flash');
    var lock = function (on) { busy = on; buttons.forEach(function (b) { b.disabled = on; }); };
    var say = function (kind, text) { flash.className = 'flash ' + kind; show(flash, text); };

    box.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-key]');
      if (!btn || busy) return;
      lock(true);
      var labelEl = btn.querySelector('.tile-label') || btn;
      var label = labelEl.textContent;
      labelEl.textContent = 'Saving...';
      api('/api/status', { status: btn.getAttribute('data-key'), backAt: $('backAt').value, note: $('note').value })
        .then(function (s) {
          labelEl.textContent = label;
          $('cur').textContent = s.label;
          $('dot').className = 'dot s-' + s.color;
          $('curExtra').textContent = [s.backAt ? 'back at ' + s.backAt : '', s.note ? '"' + s.note + '"' : ''].filter(Boolean).join(' - ');
          buttons.forEach(function (b) { b.classList.toggle('current', b.getAttribute('data-key') === s.key); });
          $('backAt').value = '';
          $('note').value = '';
          var left = cooldown;
          (function tick() {
            if (left <= 0) { lock(false); return; }
            say('ok', 'Status updated. You can change it again in ' + left + 's.');
            left--;
            setTimeout(tick, 1000);
          })();
        })
        .catch(function (err) {
          labelEl.textContent = label;
          say('error', err.message);
          lock(false);
        });
    });
  }

  // ---- sign out ----
  var logout = $('logout');
  if (logout) {
    logout.addEventListener('click', function () {
      logout.disabled = true;
      api('/api/logout').then(function () { location.href = '/nurse'; }, function () { location.href = '/nurse'; });
    });
  }

  // ---- change password ----
  var pwForm = $('passwordForm');
  if (pwForm) {
    pwForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = pwForm.querySelector('button');
      show($('formError'), '');
      show($('formOk'), '');
      var current = $('current').value, next = $('next').value, confirm = $('confirm').value;
      if (!current || !next) return show($('formError'), 'Fill in your current and new password.');
      if (next.length < 10) return show($('formError'), 'The new password needs at least 10 characters.');
      if (next !== confirm) return show($('formError'), 'The two new passwords don\'t match.');
      btn.disabled = true;
      api('/api/password', { current: current, next: next })
        .then(function (data) {
          csrf = data.csrf;
          pwForm.reset();
          show($('formOk'), 'Password changed. Any other computers have been signed out.');
        })
        .catch(function (err) { show($('formError'), err.message); })
        .then(function () { btn.disabled = false; });
    });
  }
})();
