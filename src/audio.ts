// Tiny synthesized UI sounds — no audio assets. Everything is quiet and short:
// a felt-hammer clack for keycaps, a drier tick for mouse/Finder clicks.
// The AudioContext is created lazily on the first call (inside a user gesture).

let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

function ensure(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      const len = Math.floor(ctx.sampleRate * 0.05);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function burst(freq: number, gainPeak: number, decay: number): void {
  const c = ensure();
  if (!c || !noiseBuf) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const gain = c.createGain();
  gain.gain.setValueAtTime(gainPeak, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
  src.connect(filter).connect(gain).connect(c.destination);
  src.start();
  src.stop(c.currentTime + decay);
}

/** Keycap press — soft, slightly hollow clack. */
export function keyClack(): void {
  burst(1400 + Math.random() * 500, 0.10, 0.045);
}

/** Mouse button / Finder click — short dry tick. */
export function clickTick(): void {
  burst(2600 + Math.random() * 400, 0.06, 0.03);
}
