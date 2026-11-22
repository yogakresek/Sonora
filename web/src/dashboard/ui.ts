// Tiny DOM helpers and the dashboard's controls (Fluent-style).

type Child = Node | string | null | undefined | false;

interface Props {
  class?: string;
  html?: string;
  text?: string;
  title?: string;
  style?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.html !== undefined) el.innerHTML = props.html;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.style) el.setAttribute('style', props.style);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  if (props.on) for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ------------------------------------------------------------------ icons (24×24, stroke)

const stroke = (d: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const fill = (d: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">${d}</svg>`;

export const icon = {
  home: stroke('<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>'),
  visualizer: stroke('<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'),
  lyrics: stroke('<path d="M5 6h14M5 10.5h10M5 15h14M5 19.5h7"/>'),
  audio: stroke('<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>'),
  settings: stroke('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  play: fill('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>'),
  pause: fill('<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>'),
  prev: fill('<rect x="5" y="5" width="2.5" height="14" rx="1"/><path d="M19 6.2v11.6a1 1 0 0 1-1.55.83L9.3 12.83a1 1 0 0 1 0-1.66l8.15-5.8A1 1 0 0 1 19 6.2z"/>'),
  next: fill('<rect x="16.5" y="5" width="2.5" height="14" rx="1"/><path d="M5 6.2v11.6a1 1 0 0 0 1.55.83l8.15-5.8a1 1 0 0 0 0-1.66L6.55 5.37A1 1 0 0 0 5 6.2z"/>'),
  lock: stroke('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  reset: stroke('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>'),
  eye: stroke('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  folder: stroke('<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  power: stroke('<path d="M12 3.5v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>'),
  speed: stroke('<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="M12 13l4-4.5"/>'),
  clock: stroke('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  chevron: stroke('<path d="M9.5 6l6 6-6 6"/>'),
  music: stroke('<path d="M9 18.5V6l11-2v12.5"/><circle cx="6.5" cy="18.5" r="2.5"/><circle cx="17.5" cy="16.5" r="2.5"/>'),
  spark: stroke('<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/>'),
  calm: stroke('<path d="M3 14c2.5-3 4.5-3 7 0s4.5 3 7 0 3.5-2 4-2"/><path d="M3 9c2.5-3 4.5-3 7 0s4.5 3 7 0 3.5-2 4-2" opacity=".55"/>'),
  queue: stroke('<path d="M4 6.5h11M4 11.5h11M4 16.5h7"/><path d="M17 14.5v5l4-2.5z" fill="currentColor"/>'),
  trash: stroke('<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7"/><path d="M10 11v5.5M14 11v5.5"/>'),
  info: stroke('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h0"/>'),
};

// ------------------------------------------------------------------ layout pieces

export function pageHeader(title: string, subtitle: string, ...actions: Child[]): HTMLElement {
  return h('header', { class: 'page__header' },
    h('div', {}, h('h1', { text: title }), h('p', { class: 'page__sub', text: subtitle })),
    h('div', { class: 'page__actions' }, ...actions));
}

export function group(title: string, ...rows: Child[]): HTMLElement {
  return h('section', { class: 'group' },
    h('h2', { class: 'group__title', text: title }),
    h('div', { class: 'group__card' }, ...rows));
}

/** One setting: icon, label and description on the left, control on the right. */
export function row(label: string, desc: string | null, control: Child, ico?: string): HTMLElement {
  return h('div', { class: 'row' },
    ico ? h('span', { class: 'row__icon', html: ico }) : null,
    h('div', { class: 'row__text' }, h('div', { class: 'row__label', text: label }), desc ? h('div', { class: 'row__desc', text: desc }) : null),
    h('div', { class: 'row__control' }, control));
}

// ------------------------------------------------------------------ controls

export interface Toggle extends HTMLLabelElement { set(value: boolean): void }

export function toggle(checked: boolean, onChange: (v: boolean) => void, label?: string): Toggle {
  const input = h('input', { attrs: { type: 'checkbox', role: 'switch' } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const text = label ? h('span', { class: 'toggle__label', text: checked ? 'Aktif' : 'Mati' }) : null;
  if (text) input.addEventListener('change', () => (text.textContent = input.checked ? 'Aktif' : 'Mati'));
  const el = h('label', { class: 'toggle' }, text, input, h('span', { class: 'toggle__track' })) as Toggle;
  el.set = (v) => {
    input.checked = v;
    if (text) text.textContent = v ? 'Aktif' : 'Mati';
  };
  return el;
}

export function slider(o: { min: number; max: number; step: number; value: number; format: (v: number) => string; onInput: (v: number) => void }): HTMLElement {
  const input = h('input', { class: 'slider__input', attrs: { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step) } });
  input.value = String(o.value);
  const out = h('output', { class: 'slider__value', text: o.format(o.value) });
  const paint = () => {
    const p = ((Number(input.value) - o.min) / (o.max - o.min)) * 100;
    input.style.setProperty('--p', `${p}%`);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = o.format(v);
    paint();
    o.onInput(v);
  });
  paint();
  return h('div', { class: 'slider' }, input, out);
}

export function segmented<T extends string | number>(items: { value: T; label: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const el = h('div', { class: 'seg', attrs: { role: 'radiogroup' } });
  for (const item of items) {
    const b = h('button', { class: 'seg__item', text: item.label, attrs: { type: 'button', role: 'radio' } });
    b.setAttribute('aria-checked', String(item.value === value));
    b.addEventListener('click', () => {
      el.querySelectorAll('.seg__item').forEach((x) => x.setAttribute('aria-checked', 'false'));
      b.setAttribute('aria-checked', 'true');
      onChange(item.value);
    });
    el.append(b);
  }
  return el;
}

export function button(label: string, onClick: () => void, variant: 'default' | 'primary' | 'subtle' | 'danger' = 'default', ico?: string): HTMLButtonElement {
  const b = h('button', { class: `btn btn--${variant}`, attrs: { type: 'button' } },
    ico ? h('span', { class: 'btn__icon', html: ico }) : null, label);
  b.addEventListener('click', onClick);
  return b;
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
