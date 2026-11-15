// The right bar's width: drag its left edge; the width is remembered on this Mac. Double-click the edge for the default.
const KEY = 'tessera.rightw', MIN = 280;
const set = w => { document.documentElement.style.setProperty('--rightw', w + 'px'); };

export function initResize() {
  const bar = document.getElementById('rightbar');
  if (!bar || document.getElementById('rightgrip')) return;
  const grip = document.createElement('div');
  grip.id = 'rightgrip'; grip.title = 'Drag to resize';
  bar.append(grip);
  const saved = Number(localStorage.getItem(KEY));
  if (saved >= MIN) set(Math.min(saved, Math.round(window.innerWidth * 0.7)));
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId); grip.classList.add('drag'); document.body.classList.add('resizing');
    const right = bar.getBoundingClientRect().right;
    let w = bar.getBoundingClientRect().width;
    const move = m => { w = Math.round(Math.max(MIN, Math.min(window.innerWidth * 0.7, right - m.clientX))); set(w); };
    const up = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      grip.classList.remove('drag'); document.body.classList.remove('resizing');
      localStorage.setItem(KEY, String(w));
      window.dispatchEvent(new Event('resize'));
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => { localStorage.removeItem(KEY); document.documentElement.style.removeProperty('--rightw'); window.dispatchEvent(new Event('resize')); });
}
