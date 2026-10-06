// Keyboard-wedge barcode scanner support.
// USB/Bluetooth scanners in HID mode "type" the code very fast and finish with Enter.
// We use inter-key timing to tell a scanner burst from a human typing.
const BURST_MS = 35;      // max gap between scanner keystrokes
const MIN_LEN = 6;        // shortest code we treat as a scan

/**
 * Guard a numeric/text input (e.g. cash tendered) against accidental scans:
 * if a fast burst ending in Enter arrives, the burst is removed and onScan(code) is called instead.
 */
export function guardInput(input, onScan) {
  let buf = ''; let last = 0; let startVal = '';
  input.addEventListener('keydown', (e) => {
    const now = performance.now();
    if (e.key === 'Enter') {
      if (buf.length >= MIN_LEN && now - last < BURST_MS * 3) {
        e.preventDefault(); e.stopImmediatePropagation();
        input.value = startVal;
        const code = buf; buf = '';
        onScan(code);
      }
      buf = '';
      return;
    }
    if (e.key.length === 1) {
      if (now - last > BURST_MS) { buf = ''; startVal = input.value; }
      buf += e.key; last = now;
    }
  }, true);
}

/** Parse "3*CODE" (quantity multiplier) or "CODE". */
export function parseScanInput(text) {
  const m = /^(\d{1,4}(?:\.\d{1,3})?)\s*[*xX]\s*(.+)$/.exec(text.trim());
  if (m) return { qty: Number(m[1]), code: m[2].trim() };
  return { qty: null, code: text.trim() };
}

/** Audible feedback (optional; uses WebAudio, no assets). */
let ctx = null;
export function beep(ok = true) {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = ok ? 1250 : 220; o.type = ok ? 'sine' : 'square';
    g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + (ok ? 0.06 : 0.22));
  } catch (_) { /* audio not available */ }
}
