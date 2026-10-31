// ============================================================
//  ResearchOS — iconos de línea (SVG en línea, un solo trazo)
//
//  Un único estilo para el menú, la paleta de comandos y la barra móvil. Antes se mezclaban emojis de colores con
//  símbolos de texto; con trazos que heredan `currentColor` los iconos siguen el tema, el acento y el estado activo.
// ============================================================

'use strict';

const _ICON_PATHS = {
  today:         '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  projects:      '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  list:          '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  timeline:      '<rect x="3" y="4" width="10" height="4" rx="1"/><rect x="8" y="10" width="13" height="4" rx="1"/><rect x="5" y="16" width="8" height="4" rx="1"/>',
  nested:        '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
  ideas:         '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  triage:        '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  calendar:      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  network:       '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8.2 7 7.6.7M7.3 8.2l3.5 7.7M16.8 10.2l-3.6 5.7"/>',
  references:    '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>',
  snippets:      '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>',
  star:          '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  meetings:      '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  collaborators: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2A5 5 0 0 1 21 19"/>',
  review:        '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  report:        '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  submissions:   '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/>',
  areas:         '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  archived:      '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  filesystem:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  orphans:       '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  tutorial:      '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
  settings:      '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  plus:          '<path d="M12 5v14M5 12h14"/>',
  search:        '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  menu:          '<path d="M4 7h16M4 12h16M4 17h16"/>',
  keyboard:      '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  capture:       '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  theme:         '<path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10z"/>',
  project:       '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
};

/** SVG en línea del icono `name` (vacío si no existe). Hereda color y tamaño del texto. */
function uiIcon(name, size = 17) {
  const p = _ICON_PATHS[name];
  return p ? `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${p}</svg>` : '';
}

/** Rellena todo `[data-ico]` del documento (el menú lateral está escrito en el HTML). */
function paintIcons(root = document) {
  root.querySelectorAll('[data-ico]').forEach(el => { if (!el.firstElementChild) el.innerHTML = uiIcon(el.dataset.ico, +el.dataset.icoSize || 17); });
}
paintIcons();
