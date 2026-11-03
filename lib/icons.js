'use strict';

// Line icons (24x24, drawn with the current text color). Pages include them once as a hidden
// sprite and reference them with <use href="#i-name">, which keeps the strict CSP happy.

const ICONS = {
  cross: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9M7.5 12h9"/>',
  lunch: '<path d="M7 3v18M4.5 3v4.5a2.5 2.5 0 0 0 5 0V3M17.5 21V3c-2.2 1.2-3.5 4-3.5 8h3.5"/>',
  walk: '<circle cx="13.5" cy="4" r="1.6"/><path d="M10 21l2.4-6 2.6 2.4V21M12.4 15l.6-6-3.3 2V14M13 9l2.6 2.8 3 .8"/>',
  bus: '<rect x="4" y="3" width="16" height="14" rx="2"/><path d="M4 10.5h16M7.5 17v3M16.5 17v3M8 13.8h.01M16 13.8h.01"/>',
  moon: '<path d="M20 14.6A8 8 0 1 1 9.4 4a6.4 6.4 0 0 0 10.6 10.6z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/>',
  board: '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>',
  dot: '<circle cx="12" cy="12" r="5"/>',
};

const has = name => Object.prototype.hasOwnProperty.call(ICONS, name);

function sprite() {
  const symbols = Object.entries(ICONS).map(([name, body]) =>
    `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" hidden>${symbols}</svg>`;
}

const icon = (name, cls = 'icon', id = '') =>
  `<svg class="${cls}" aria-hidden="true"><use${id ? ` id="${id}"` : ''} href="#i-${has(name) ? name : 'dot'}"/></svg>`;

module.exports = { sprite, icon, has };
