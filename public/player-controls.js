// One idle timer; media state and active interaction always win over hiding.
export class PlayerControls {
  constructor({ root, chrome, stage, video, blocked, cancelDrag = () => {}, doc = document, delay = 3000 }) {
    Object.assign(this, { root, chrome, stage, video, blocked, cancelDrag, doc, delay });
    this.active = true; this.cinema = false; this.focused = false; this.pointers = new Set(); this.listeners = [];
    const on = (target, name, fn, options) => { target.addEventListener(name, fn, options); this.listeners.push(() => target.removeEventListener(name, fn, options)); };
    on(root, 'pointermove', () => this.wake());
    on(root, 'keydown', () => this.wake());
    on(stage, 'pointerdown', () => {
      if (chrome.contains(doc.activeElement)) doc.activeElement.blur?.();
      this.wake(); // A first tap reveals controls, never toggles playback.
    });
    on(chrome, 'click', event => {
      event.stopPropagation();
      const target = event.composedPath?.()[0] || event.target;
      // A released pointer click must not leave a button pinning chrome forever.
      // Keyboard focus (detail=0), sliders and native selects stay protected.
      if (event.detail > 0 && target.closest?.('button')) {
        target.closest('button').blur(); this.focused = chrome.contains(doc.activeElement);
      }
      this.wake();
    });
    on(chrome, 'pointerdown', event => { event.stopPropagation(); this.pointers.add(event.pointerId); this.wake(); });
    for (const name of ['pointerup', 'pointercancel']) on(doc, name, event => {
      if (!this.pointers.delete(event.pointerId)) return;
      if (name === 'pointercancel') this.cancelDrag();
      this.wake();
    }, true);
    on(chrome, 'focusin', () => { this.focused = true; this.wake(); });
    on(chrome, 'focusout', event => { this.focused = chrome.contains(event.relatedTarget); this.wake(); });
    for (const name of ['input', 'change']) on(chrome, name, () => this.wake());
    for (const name of ['playing', 'pause', 'ended', 'waiting', 'stalled', 'canplay', 'error']) on(video, name, () => this.refresh());
  }
  clear() { clearTimeout(this.timer); this.timer = null; }
  show() { this.root.classList.toggle('controls-hidden', false); }
  canHide() { return this.active && this.cinema && !this.focused && !this.pointers.size && !this.blocked(); }
  refresh() {
    if (!this.canHide()) { this.clear(); this.show(); return; }
    if (this.timer || this.root.classList.contains('controls-hidden')) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.canHide()) this.root.classList.toggle('controls-hidden', true);
      else this.show();
    }, this.delay);
  }
  wake() { this.clear(); this.show(); this.refresh(); }
  setCinema(enabled) { this.cinema = Boolean(enabled); this.wake(); }
  start() { this.active = true; this.focused = this.chrome.contains(this.doc.activeElement); this.wake(); }
  reset() { this.active = false; this.pointers.clear(); this.focused = false; this.clear(); this.show(); }
  destroy() { this.reset(); for (const remove of this.listeners) remove(); this.listeners = []; }
}
