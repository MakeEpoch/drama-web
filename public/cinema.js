// Page-local cinema mode. Never invokes a browser/native fullscreen API.
export class PageCinema {
  constructor(root, button, doc = document, win = window) {
    this.root = root; this.button = button; this.doc = doc;
    this.media = win.matchMedia('(orientation: landscape) and (pointer: coarse) and (max-height: 600px)');
    this.active = false; this.manual = false; this.suppressed = false;
    this.orientation = () => { if (!this.media.matches) { this.suppressed = false; this.manual = false; } this.update(); };
    this.escape = event => { if (event.key === 'Escape' && this.enabled) this.toggle(); };
    if (this.media.addEventListener) this.media.addEventListener('change', this.orientation);
    else this.media.addListener(this.orientation);
    doc.addEventListener('keydown', this.escape);
  }
  setActive(active) {
    this.active = Boolean(active);
    if (!this.active) { this.manual = false; this.suppressed = false; }
    this.update();
  }
  toggle() {
    if (!this.active) return;
    if (this.enabled) { this.manual = false; this.suppressed = this.media.matches; }
    else { this.manual = true; this.suppressed = false; }
    this.update();
  }
  update() {
    const previous = this.enabled;
    this.enabled = this.active && (this.manual || this.media.matches && !this.suppressed);
    this.doc.body.classList.toggle('page-cinema', this.enabled);
    this.root.classList.toggle('page-cinema-player', this.enabled);
    this.button.textContent = this.enabled ? '退出全屏' : '全屏';
    this.button.setAttribute('aria-pressed', String(this.enabled));
    if (previous !== this.enabled) this.onChange?.(this.enabled);
  }
  destroy() {
    this.setActive(false);
    if (this.media.removeEventListener) this.media.removeEventListener('change', this.orientation);
    else this.media.removeListener(this.orientation);
    this.doc.removeEventListener('keydown', this.escape);
  }
}
