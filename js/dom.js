// ── DOM helpers with XSS-safe interpolation ──────────
// `html` is a tagged template that auto-escapes interpolations and returns a
// DocumentFragment. Use `html.raw` for opt-in trusted HTML (sparingly).
//
// Usage:
//   const frag = html`<div class="x">${userInput}</div>`;
//   container.replaceChildren(frag);
//
// For building strings (legacy innerHTML contexts), use `esc(str)` to escape.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

// Mark a string as safe to insert as raw HTML (no escaping).
class Raw { constructor(s) { this.s = s; } }
export function raw(s) { return new Raw(String(s)); }

// Tagged template that returns a DocumentFragment, auto-escaping interpolations.
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Raw) out += v.s;
      else if (Array.isArray(v)) out += v.map(x => x instanceof Raw ? x.s : esc(x)).join('');
      else out += esc(v);
    }
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = out;
  return tpl.content;
}
html.raw = raw;

// Convenience wrappers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $id = (id) => document.getElementById(id);

// Replace children with a fragment (or HTML string, which we escape-by-default).
export function replace(target, frag) {
  if (typeof target === 'string') target = $id(target);
  if (!target) return;
  if (frag instanceof DocumentFragment || frag instanceof Node) {
    target.replaceChildren(frag);
  } else {
    target.textContent = String(frag ?? '');
  }
}
