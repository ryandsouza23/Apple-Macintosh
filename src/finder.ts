// System 1.0 Finder — state-driven 1-bit canvas engine.
// Logical resolution 512x342 (classic Mac), drawn at 2x for crispness.
// Pure draw(state) -> canvas; interactivity wires events to state changes.

export const SCREEN_W = 512;
export const SCREEN_H = 342;
const SCALE = 2;

const BLACK = '#0a0a0a';
const WHITE = '#eeeeec';

export type FinderIcon = {
  id: string;
  label: string;
  kind: 'folder' | 'app' | 'doc' | 'trash' | 'disk' | 'floppy' | 'music' | 'paint' | 'puzzle' | 'calc' | 'book' | 'web';
  x: number; // logical px, icon center
  y: number;
};

export type FinderWindow = {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  info: string | null; // "4 items   196K in disk   201K available"
  icons: FinderIcon[];
  text?: string[]; // TeachText-style content
  player?: boolean; // Music: 1-bit player UI driven by the Spotify bridge
  app?: 'about' | 'paint' | 'puzzle' | 'calc' | 'guestbook' | 'web'; // built-in desk apps
};

export type MusicTrack = { uri: string; title: string; artist: string; art?: HTMLCanvasElement | null };
export type MusicState = {
  tracks: MusicTrack[];
  current: number; // -1 = none
  isPaused: boolean;
  position: number; // seconds
  duration: number; // seconds
};
export type WebRun = { text: string; link?: number };
export type WebBlock = { style: 'h' | 'p' | 'li' | 'pre'; runs: WebRun[] };

export type MusicCommand =
  | { type: 'play-track'; index: number }
  | { type: 'toggle' }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'seek'; seconds: number };

export type MenuDef = { title: string; items: { label: string; enabled: boolean }[] };

export type FinderState = {
  windows: FinderWindow[]; // last = frontmost
  openMenu: number | null;
  hoverMenuItem: number | null;
  selectedIcon: string | null;
  cursor: { x: number; y: number; visible: boolean };
};

export const MENUS: MenuDef[] = [
  { title: '\u{F8FF}', items: [{ label: 'About the Finder…', enabled: true }] },
  {
    title: 'File',
    items: [
      { label: 'Open', enabled: true },
      { label: 'Duplicate', enabled: false },
      { label: 'Get Info', enabled: false },
      { label: 'Put Back', enabled: false },
      { label: 'Close', enabled: true },
      { label: 'Close All', enabled: true },
      { label: 'Print', enabled: false },
      { label: 'Eject', enabled: true },
    ],
  },
  {
    title: 'Edit',
    items: [
      { label: 'Undo', enabled: false },
      { label: 'Cut', enabled: false },
      { label: 'Copy', enabled: false },
      { label: 'Paste', enabled: false },
      { label: 'Clear', enabled: false },
      { label: 'Select All', enabled: true },
    ],
  },
  {
    title: 'View',
    items: [
      { label: 'by Icon', enabled: true },
      { label: 'by Name', enabled: true },
      { label: 'by Size', enabled: true },
      { label: 'by Kind', enabled: true },
    ],
  },
  {
    title: 'Special',
    items: [
      { label: 'Clean Up', enabled: true },
      { label: 'Empty Trash', enabled: true },
      { label: 'Erase Disk', enabled: false },
      { label: 'Shut Down', enabled: true },
    ],
  },
];

const MENU_XS: { x: number; w: number }[] = [];
{
  let x = 28;
  const widths = [24, 34, 34, 38, 52];
  for (const w of widths) {
    MENU_XS.push({ x, w });
    x += w;
  }
}

function systemDiskWindow(): FinderWindow {
  return {
    id: 'system-disk',
    title: 'System 1.0 disk',
    x: 22,
    y: 26,
    w: 428,
    h: 262,
    info: '0 items     202K in disk     195K available',
    icons: [],
  };
}

export function initialState(): FinderState {
  return {
    windows: [],
    openMenu: null,
    hoverMenuItem: null,
    selectedIcon: null,
    cursor: { x: 256, y: 170, visible: true },
  };
}

export class FinderCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly state: FinderState;
  private ctx: CanvasRenderingContext2D;
  onChange: (() => void) | null = null;
  onMusicCommand: ((cmd: MusicCommand) => void) | null = null;
  onShutDown: (() => void) | null = null;
  /** MacWeb asks the network layer to fetch a page. */
  onWebNavigate: ((url: string) => void) | null = null;
  /** Guestbook committed a note (network layer may sync it). */
  onGuestNote: ((note: string) => void) | null = null;
  /** While true (boot sequence), draw() is a no-op so boot frames own the canvas. */
  suspended = false;

  // --- desk apps state ---
  paintCanvas: HTMLCanvasElement | null = null;
  private paintCtx: CanvasRenderingContext2D | null = null;
  private painting = false;
  private paintTool: 'pencil' | 'eraser' = 'pencil';
  private lastPaint: { x: number; y: number } | null = null;
  puzzle = { tiles: [] as number[], moves: 0 };
  calc = { display: '0', acc: null as number | null, op: null as string | null, fresh: true };
  guest = { notes: [] as string[], draft: '' };
  // --- MacWeb state ---
  web = {
    url: '',
    input: '',
    typing: false,
    loading: false,
    error: '',
    title: 'MacWeb',
    blocks: [] as WebBlock[],
    links: [] as string[],
    scroll: 0,
    contentH: 0,
    history: [] as string[],
    /** Set when MacWeb is on a YouTube watch page — the real embed is
     *  projected onto the CRT glass over this window by tube.ts. */
    video: null as { id: string } | null,
  };
  private webLinkRects: { x: number; y: number; w: number; h: number; link: number }[] = [];
  private webScrollDrag: number | null = null;
  /** Desktop icons are draggable state, not constants. */
  deskIcons: { id: string; kind: FinderIcon['kind']; label: string; x: number; y: number }[] = [
    { id: 'about-ryan', kind: 'doc', label: 'About Ryan', x: 52, y: 64 },
    { id: 'music', kind: 'music', label: 'Music', x: 138, y: 64 },
    { id: 'macpaint', kind: 'paint', label: 'MacPaint', x: 224, y: 64 },
    { id: 'puzzle', kind: 'puzzle', label: 'Puzzle', x: 310, y: 64 },
    { id: 'calculator', kind: 'calc', label: 'Calculator', x: 396, y: 64 },
    { id: 'guestbook', kind: 'book', label: 'Guestbook', x: 52, y: 150 },
    { id: 'macweb', kind: 'web', label: 'MacWeb', x: 138, y: 150 },
    { id: 'system-folder', kind: 'folder', label: 'System Folder', x: 224, y: 150 },
  ];
  trashed: FinderIcon[] = [];
  private iconDrag: {
    win: FinderWindow | null; // null = desktop icon
    icon: FinderIcon | { id: string; x: number; y: number };
    dx: number;
    dy: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null = null;
  readonly music: MusicState = {
    tracks: [
      { uri: 'spotify:track:1qfJ6OvxrspQTmcvdIEoX6', title: 'places to be', artist: 'Fred again.., Anderson .Paak' },
      { uri: 'spotify:track:0ccoGCaOFCxI6pHixrQpKj', title: 'Neverender', artist: 'Justice, Tame Impala' },
      { uri: 'spotify:track:2VEZx7NWsZ1D0eJ4uv5Fym', title: 'Digital Love', artist: 'Daft Punk' },
      { uri: 'spotify:track:0w07a1vsKahQMM0RnPXHVT', title: 'Dancing in the Moonlight', artist: 'Toploader' },
    ],
    current: -1,
    isPaused: true,
    position: 0,
    duration: 0,
  };

  updateMusicPlayback(position: number, duration: number, isPaused: boolean): void {
    const m = this.music;
    const secChanged = Math.floor(position) !== Math.floor(m.position);
    const changed = secChanged || isPaused !== m.isPaused || Math.floor(duration) !== Math.floor(m.duration);
    m.position = position;
    m.duration = duration;
    m.isPaused = isPaused;
    if (changed && this.state.windows.some((w) => w.player)) this.draw();
  }

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCREEN_W * SCALE;
    this.canvas.height = SCREEN_H * SCALE;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(SCALE, SCALE);
    this.state = initialState();
    this.resetPuzzle();
    try {
      const raw = localStorage.getItem('mac128k-guestbook');
      if (raw) this.guest.notes = (JSON.parse(raw) as string[]).slice(0, 50);
    } catch {
      /* localStorage unavailable */
    }
    this.draw();
  }

  private resetPuzzle(): void {
    // start solved, then make random valid moves — always solvable
    const t = [...Array(15).keys()].map((n) => n + 1).concat(0);
    let gap = 15;
    for (let i = 0; i < 250; i += 1) {
      const gx = gap % 4;
      const gy = Math.floor(gap / 4);
      const opts: number[] = [];
      if (gx > 0) opts.push(gap - 1);
      if (gx < 3) opts.push(gap + 1);
      if (gy > 0) opts.push(gap - 4);
      if (gy < 3) opts.push(gap + 4);
      const pick = opts[Math.floor(Math.random() * opts.length)];
      t[gap] = t[pick];
      t[pick] = 0;
      gap = pick;
    }
    this.puzzle = { tiles: t, moves: 0 };
  }

  private font(size = 9, bold = false): string {
    return `${bold ? 'bold ' : ''}${size}px 'Geneva', 'Lucida Grande', 'Helvetica Neue', sans-serif`;
  }

  draw(): void {
    if (this.suspended) return;
    const ctx = this.ctx;
    const s = this.state;
    ctx.save();
    // desktop 50% dither
    ctx.fillStyle = '#9a9a96';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.fillStyle = '#8e8e8a';
    for (let y = 0; y < SCREEN_H; y += 2)
      for (let x = y % 4 === 0 ? 0 : 1; x < SCREEN_W; x += 2) ctx.fillRect(x, y, 1, 1);

    // desktop icons (draggable state)
    for (const di of this.deskIcons) {
      this.drawDesktopIcon(ctx, di.kind, di.label, di.x, di.y, s.selectedIcon === di.id);
    }

    // windows back-to-front
    for (const w of s.windows) this.drawWindow(ctx, w, w === s.windows[s.windows.length - 1]);

    // menu bar last (always on top)
    this.drawMenuBar(ctx);
    if (s.openMenu !== null) this.drawOpenMenu(ctx, s.openMenu);

    // cursor
    if (s.cursor.visible) this.drawCursor(ctx, s.cursor.x, s.cursor.y);
    ctx.restore();
    if (this.onChange) this.onChange();
    this.syncEqTimer();
  }

  /** Keep a slow redraw ticking while music plays so the EQ bars bounce. */
  private eqTimer = 0;
  private syncEqTimer(): void {
    const active =
      !this.suspended &&
      !this.music.isPaused &&
      this.music.current >= 0 &&
      this.state.windows.some((w) => w.player);
    if (active && !this.eqTimer) {
      this.eqTimer = window.setInterval(() => this.draw(), 150);
    } else if (!active && this.eqTimer) {
      window.clearInterval(this.eqTimer);
      this.eqTimer = 0;
    }
  }

  private drawMenuBar(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, SCREEN_W, 19);
    ctx.fillStyle = BLACK;
    ctx.fillRect(0, 19, SCREEN_W, 1);
    ctx.font = this.font(10, true);
    ctx.textBaseline = 'middle';
    MENUS.forEach((m, i) => {
      const { x, w } = MENU_XS[i];
      if (this.state.openMenu === i) {
        ctx.fillStyle = BLACK;
        ctx.fillRect(x - 4, 0, w, 19);
        ctx.fillStyle = WHITE;
      } else {
        ctx.fillStyle = BLACK;
      }
      if (i === 0) {
        this.drawApple(ctx, x + 2, 4, this.state.openMenu === 0);
      } else {
        ctx.fillText(m.title, x, 10);
      }
    });
  }

  private drawApple(ctx: CanvasRenderingContext2D, x: number, y: number, inverted: boolean): void {
    ctx.save();
    ctx.fillStyle = inverted ? WHITE : BLACK;
    // chunky 1-bit apple silhouette
    ctx.beginPath();
    ctx.arc(x + 4, y + 7, 4, Math.PI * 0.45, Math.PI * 1.7);
    ctx.arc(x + 8, y + 7, 4, Math.PI * 1.3, Math.PI * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x + 5, y + 1, 2, 3); // stem
    // bite
    ctx.fillStyle = inverted ? BLACK : WHITE;
    ctx.beginPath();
    ctx.arc(x + 11.5, y + 6, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawOpenMenu(ctx: CanvasRenderingContext2D, index: number): void {
    const menu = MENUS[index];
    const { x } = MENU_XS[index];
    const w = index === 0 ? 130 : 96;
    const itemH = 14;
    const h = menu.items.length * itemH + 4;
    ctx.fillStyle = WHITE;
    ctx.fillRect(x - 4, 20, w, h);
    ctx.strokeStyle = BLACK;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 3.5, 20.5, w - 1, h - 1);
    // drop shadow
    ctx.fillStyle = BLACK;
    ctx.fillRect(x - 2, 20 + h, w, 1);
    ctx.fillRect(x - 4 + w, 22, 1, h - 1);
    ctx.font = this.font(10);
    ctx.textBaseline = 'middle';
    menu.items.forEach((item, i) => {
      const iy = 22 + i * itemH;
      const hovered = this.state.hoverMenuItem === i && item.enabled;
      if (hovered) {
        ctx.fillStyle = BLACK;
        ctx.fillRect(x - 3, iy, w - 2, itemH);
      }
      ctx.fillStyle = hovered ? WHITE : item.enabled ? BLACK : '#8a8a86';
      ctx.fillText(item.label, x + 6, iy + itemH / 2);
    });
  }

  private drawWindow(ctx: CanvasRenderingContext2D, w: FinderWindow, active: boolean): void {
    // frame
    ctx.fillStyle = WHITE;
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = BLACK;
    ctx.lineWidth = 1;
    ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
    // shadow
    ctx.fillStyle = BLACK;
    ctx.fillRect(w.x + 1, w.y + w.h, w.w, 1);
    ctx.fillRect(w.x + w.w, w.y + 1, 1, w.h);

    // title bar
    const tb = 16;
    ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, tb);
    if (active) {
      ctx.fillStyle = BLACK;
      for (let i = 3; i < tb - 2; i += 2) {
        ctx.fillRect(w.x + 3, w.y + i, w.w - 6, 1);
      }
      // close box with white surround
      ctx.fillStyle = WHITE;
      ctx.fillRect(w.x + 6, w.y + 2, 13, tb - 4);
      ctx.fillStyle = BLACK;
      ctx.strokeRect(w.x + 8.5, w.y + 4.5, 8, 8);
    }
    // title with white backing
    ctx.font = this.font(10, true);
    const tw = ctx.measureText(w.title).width;
    ctx.fillStyle = WHITE;
    ctx.fillRect(w.x + w.w / 2 - tw / 2 - 6, w.y + 1, tw + 12, tb - 2);
    ctx.fillStyle = BLACK;
    ctx.textBaseline = 'middle';
    ctx.fillText(w.title, w.x + w.w / 2 - tw / 2, w.y + tb / 2 + 1);

    let contentY = w.y + tb;
    // info bar
    if (w.info) {
      ctx.font = this.font(9);
      ctx.fillStyle = BLACK;
      ctx.strokeRect(w.x + 0.5, contentY + 0.5, w.w - 1, 14);
      ctx.fillText(w.info, w.x + 10, contentY + 8);
      contentY += 15;
    }

    // content
    if (w.player) this.drawMusicPlayer(ctx, w);
    if (w.app === 'paint') this.drawPaintApp(ctx, w);
    else if (w.app === 'puzzle') this.drawPuzzleApp(ctx, w);
    else if (w.app === 'calc') this.drawCalcApp(ctx, w);
    else if (w.app === 'guestbook') this.drawGuestApp(ctx, w);
    else if (w.app === 'about') this.drawAboutApp(ctx, w);
    else if (w.app === 'web') this.drawWebApp(ctx, w);
    if (w.text) {
      ctx.font = this.font(9);
      ctx.fillStyle = BLACK;
      w.text.forEach((line, i) => {
        ctx.fillText(line, w.x + 8, contentY + 14 + i * 12);
      });
    }
    for (const icon of w.icons) {
      this.drawIcon(ctx, icon.kind, w.x + icon.x, w.y + icon.y, icon.label, this.state.selectedIcon === icon.id);
    }

    // scrollbars
    const sb = 14;
    ctx.fillStyle = WHITE;
    ctx.fillRect(w.x + w.w - sb, w.y + tb, sb, w.h - tb);
    ctx.fillRect(w.x, w.y + w.h - sb, w.w, sb);
    ctx.strokeRect(w.x + w.w - sb + 0.5, w.y + tb + 0.5, sb - 1, w.h - tb - 1);
    ctx.strokeRect(w.x + 0.5, w.y + w.h - sb + 0.5, w.w - 1, sb - 1);
    // arrows
    ctx.fillStyle = BLACK;
    this.drawArrow(ctx, w.x + w.w - sb / 2, w.y + tb + 7, 'up');
    this.drawArrow(ctx, w.x + w.w - sb / 2, w.y + w.h - sb - 7, 'down');
    this.drawArrow(ctx, w.x + 7, w.y + w.h - sb / 2, 'left');
    this.drawArrow(ctx, w.x + w.w - sb - 7, w.y + w.h - sb / 2, 'right');
    // grow box
    ctx.strokeRect(w.x + w.w - sb + 2.5, w.y + w.h - sb + 2.5, 7, 7);
    ctx.strokeRect(w.x + w.w - sb + 4.5, w.y + w.h - sb + 4.5, 7, 7);
  }

  private fmtTime(s: number): string {
    if (!isFinite(s) || s <= 0) return '0:00';
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${ss < 10 ? '0' : ''}${ss}`;
  }

  private drawMusicPlayer(ctx: CanvasRenderingContext2D, w: FinderWindow): void {
    const m = this.music;
    const left = w.x + 8;
    const right = w.x + w.w - 22;
    ctx.font = this.font(9);
    ctx.textBaseline = 'middle';
    // track rows
    m.tracks.forEach((tr, i) => {
      const ry = w.y + 24 + i * 24;
      const selected = i === m.current;
      if (selected) {
        ctx.fillStyle = BLACK;
        ctx.fillRect(left, ry, right - left, 22);
      }
      ctx.fillStyle = selected ? WHITE : BLACK;
      ctx.textAlign = 'right';
      ctx.fillText(String(i + 1), left + 16, ry + 11);
      ctx.textAlign = 'left';
      const label = tr.artist ? `${tr.title} — ${tr.artist}` : tr.title;
      const maxW = right - left - 66;
      let shown = label;
      while (ctx.measureText(shown).width > maxW && shown.length > 4) shown = shown.slice(0, -2);
      if (shown !== label) shown += '…';
      ctx.fillText(shown, left + 24, ry + 11);
      if (selected && !m.isPaused) {
        // tiny equalizer — bars bounce while the track plays
        const t = performance.now() / 1000;
        const bh = (phase: number, speed: number) => 3 + Math.abs(Math.sin(t * speed + phase)) * 9;
        const hs = [bh(0, 5.1), bh(1.4, 6.3), bh(2.6, 4.4)];
        ctx.fillRect(right - 34, ry + 15 - hs[0], 2, hs[0]);
        ctx.fillRect(right - 30, ry + 15 - hs[1], 2, hs[1]);
        ctx.fillRect(right - 26, ry + 15 - hs[2], 2, hs[2]);
      }
      ctx.strokeStyle = '#c8c6bc';
      ctx.beginPath();
      ctx.moveTo(left, ry + 22.5);
      ctx.lineTo(right, ry + 22.5);
      ctx.stroke();
    });
    // now playing: dithered album art + labels
    const artX = w.x + 10;
    const artY = w.y + 152;
    const cur = m.current >= 0 ? m.tracks[m.current] : null;
    ctx.strokeStyle = BLACK;
    ctx.strokeRect(artX + 0.5, artY + 0.5, 48, 48);
    if (cur && cur.art) {
      ctx.drawImage(cur.art, artX + 1, artY + 1, 47, 47);
    } else {
      // placeholder: 1-bit note in the frame
      ctx.fillStyle = BLACK;
      ctx.beginPath();
      ctx.ellipse(artX + 18, artY + 33, 5, 3.6, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(artX + 32, artY + 30, 5, 3.6, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(artX + 22, artY + 32);
      ctx.lineTo(artX + 22, artY + 15);
      ctx.lineTo(artX + 36, artY + 12);
      ctx.lineTo(artX + 36, artY + 29);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = BLACK;
    ctx.font = this.font(9, true);
    let nowTitle = cur ? cur.title : 'Select a track';
    while (ctx.measureText(nowTitle).width > w.w - 92 && nowTitle.length > 4)
      nowTitle = nowTitle.slice(0, -2);
    ctx.fillText(nowTitle, w.x + 66, w.y + 161);
    ctx.font = this.font(9);
    ctx.fillStyle = '#55534c';
    ctx.fillText(cur ? cur.artist : '', w.x + 66, w.y + 173);
    ctx.fillStyle = BLACK;
    // transport — left-aligned under the title/artist block
    const cx = w.x + 114.5;
    const ty = w.y + 182;
    ctx.strokeStyle = BLACK;
    ctx.fillStyle = BLACK;
    // prev
    ctx.strokeRect(cx - 48.5, ty + 0.5, 22, 18);
    ctx.fillRect(cx - 45, ty + 4, 2, 11);
    ctx.beginPath();
    ctx.moveTo(cx - 33, ty + 4);
    ctx.lineTo(cx - 33, ty + 15);
    ctx.lineTo(cx - 41, ty + 9.5);
    ctx.closePath();
    ctx.fill();
    // play / pause
    ctx.strokeRect(cx - 12.5, ty + 0.5, 25, 18);
    if (m.isPaused || m.current < 0) {
      ctx.beginPath();
      ctx.moveTo(cx - 4, ty + 4);
      ctx.lineTo(cx + 6, ty + 9.5);
      ctx.lineTo(cx - 4, ty + 15);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(cx - 5, ty + 4, 3, 11);
      ctx.fillRect(cx + 2, ty + 4, 3, 11);
    }
    // next
    ctx.strokeRect(cx + 26.5, ty + 0.5, 22, 18);
    ctx.beginPath();
    ctx.moveTo(cx + 31, ty + 4);
    ctx.lineTo(cx + 31, ty + 15);
    ctx.lineTo(cx + 39, ty + 9.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(cx + 41, ty + 4, 2, 11);
    // progress bar + time
    const py = w.y + 214;
    const pLeft = w.x + 12;
    const pRight = w.x + w.w - 92;
    ctx.strokeStyle = BLACK;
    ctx.strokeRect(pLeft + 0.5, py + 0.5, pRight - pLeft, 9);
    if (m.duration > 0) {
      const frac = Math.min(1, m.position / m.duration);
      ctx.fillStyle = BLACK;
      ctx.fillRect(pLeft + 2, py + 2, Math.max(0, (pRight - pLeft - 4) * frac), 6);
    }
    ctx.font = this.font(9);
    ctx.fillStyle = BLACK;
    ctx.textAlign = 'right';
    ctx.fillText(`${this.fmtTime(m.position)}/${this.fmtTime(m.duration)}`, w.x + w.w - 18, py + 5);
    ctx.textAlign = 'left';
  }

  /** Player window clicks: rows, transport, progress. Returns true when handled. */
  private musicClick(w: FinderWindow, x: number, y: number): boolean {
    const send = (cmd: MusicCommand) => {
      if (this.onMusicCommand) this.onMusicCommand(cmd);
    };
    const left = w.x + 8;
    const right = w.x + w.w - 22;
    for (let i = 0; i < this.music.tracks.length; i += 1) {
      const ry = w.y + 24 + i * 24;
      if (x >= left && x <= right && y >= ry && y <= ry + 22) {
        if (i === this.music.current) send({ type: 'toggle' });
        else send({ type: 'play-track', index: i });
        return true;
      }
    }
    const cx = w.x + 114.5;
    const ty = w.y + 182;
    if (y >= ty && y <= ty + 19) {
      if (x >= cx - 49 && x <= cx - 26) {
        send({ type: 'prev' });
        return true;
      }
      if (x >= cx - 13 && x <= cx + 13) {
        send({ type: 'toggle' });
        return true;
      }
      if (x >= cx + 26 && x <= cx + 49) {
        send({ type: 'next' });
        return true;
      }
    }
    const py = w.y + 214;
    const pLeft = w.x + 12;
    const pRight = w.x + w.w - 92;
    if (y >= py - 2 && y <= py + 12 && x >= pLeft && x <= pRight && this.music.duration > 0) {
      const frac = (x - pLeft) / (pRight - pLeft);
      send({ type: 'seek', seconds: frac * this.music.duration });
      return true;
    }
    return false;
  }

  // ---------- desk apps ----------

  private ensurePaint(): CanvasRenderingContext2D {
    if (!this.paintCanvas) {
      this.paintCanvas = document.createElement('canvas');
      this.paintCanvas.width = 280;
      this.paintCanvas.height = 148;
      this.paintCtx = this.paintCanvas.getContext('2d')!;
      this.paintCtx.fillStyle = WHITE;
      this.paintCtx.fillRect(0, 0, 280, 148);
    }
    return this.paintCtx!;
  }

  private drawPaintApp(ctx: CanvasRenderingContext2D, w: FinderWindow): void {
    this.ensurePaint();
    // toolbar
    ctx.font = this.font(9);
    ctx.textBaseline = 'middle';
    const tools: [string, string][] = [
      ['pencil', 'Pencil'],
      ['eraser', 'Eraser'],
      ['clear', 'Clear'],
    ];
    tools.forEach(([id, label], i) => {
      const bx = w.x + 10 + i * 62;
      const active = this.paintTool === id;
      ctx.fillStyle = active ? BLACK : WHITE;
      ctx.fillRect(bx, w.y + 22, 56, 16);
      ctx.strokeStyle = BLACK;
      ctx.strokeRect(bx + 0.5, w.y + 22.5, 56, 16);
      ctx.fillStyle = active ? WHITE : BLACK;
      ctx.textAlign = 'center';
      ctx.fillText(label, bx + 28, w.y + 30);
    });
    ctx.textAlign = 'left';
    // canvas
    ctx.strokeStyle = BLACK;
    ctx.strokeRect(w.x + 9.5, w.y + 43.5, 281, 149);
    ctx.drawImage(this.paintCanvas!, w.x + 10, w.y + 44);
  }

  private paintClick(w: FinderWindow, x: number, y: number, drag: boolean): boolean {
    const g = this.ensurePaint();
    if (!drag && y >= w.y + 22 && y <= w.y + 38) {
      const i = Math.floor((x - (w.x + 10)) / 62);
      if (i === 0) this.paintTool = 'pencil';
      else if (i === 1) this.paintTool = 'eraser';
      else if (i === 2) {
        g.fillStyle = WHITE;
        g.fillRect(0, 0, 280, 148);
      }
      return true;
    }
    const px = x - (w.x + 10);
    const py = y - (w.y + 44);
    if (px >= 0 && px < 280 && py >= 0 && py < 148) {
      g.strokeStyle = this.paintTool === 'pencil' ? BLACK : WHITE;
      g.lineWidth = this.paintTool === 'pencil' ? 2.5 : 10;
      g.lineCap = 'round';
      g.beginPath();
      const from = drag && this.lastPaint ? this.lastPaint : { x: px, y: py };
      g.moveTo(from.x, from.y);
      g.lineTo(px, py);
      g.stroke();
      this.lastPaint = { x: px, y: py };
      this.painting = true;
      return true;
    }
    return false;
  }

  private drawPuzzleApp(ctx: CanvasRenderingContext2D, w: FinderWindow): void {
    const size = 30;
    const ox = w.x + 12;
    const oy = w.y + 24;
    ctx.font = this.font(10, true);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    this.puzzle.tiles.forEach((n, i) => {
      const tx = ox + (i % 4) * size;
      const ty = oy + Math.floor(i / 4) * size;
      if (n === 0) return;
      ctx.fillStyle = WHITE;
      ctx.fillRect(tx, ty, size - 2, size - 2);
      ctx.strokeStyle = BLACK;
      ctx.strokeRect(tx + 0.5, ty + 0.5, size - 3, size - 3);
      ctx.fillStyle = BLACK;
      ctx.fillText(String(n), tx + size / 2 - 1, ty + size / 2);
    });
    ctx.font = this.font(9);
    ctx.textAlign = 'left';
    const solved = this.puzzle.tiles.slice(0, 15).every((n, i) => n === i + 1);
    ctx.fillText(
      solved && this.puzzle.moves > 0
        ? `Solved in ${this.puzzle.moves}!`
        : `${this.puzzle.moves} moves`,
      ox,
      w.y + 24 + 4 * size + 10,
    );
    ctx.textAlign = 'right';
    ctx.fillText('New', w.x + w.w - 20, w.y + 24 + 4 * size + 10);
    ctx.textAlign = 'left';
  }

  private puzzleClick(w: FinderWindow, x: number, y: number): boolean {
    const size = 30;
    const ox = w.x + 12;
    const oy = w.y + 24;
    if (y >= oy + 4 * size && x >= w.x + w.w - 52) {
      this.resetPuzzle();
      return true;
    }
    const cx = Math.floor((x - ox) / size);
    const cy = Math.floor((y - oy) / size);
    if (cx < 0 || cx > 3 || cy < 0 || cy > 3) return false;
    const i = cy * 4 + cx;
    const gap = this.puzzle.tiles.indexOf(0);
    const gx = gap % 4;
    const gy = Math.floor(gap / 4);
    if (Math.abs(gx - cx) + Math.abs(gy - cy) === 1) {
      this.puzzle.tiles[gap] = this.puzzle.tiles[i];
      this.puzzle.tiles[i] = 0;
      this.puzzle.moves += 1;
    }
    return true;
  }

  private drawCalcApp(ctx: CanvasRenderingContext2D, w: FinderWindow): void {
    ctx.strokeStyle = BLACK;
    ctx.fillStyle = WHITE;
    ctx.fillRect(w.x + 10, w.y + 22, w.w - 34, 18);
    ctx.strokeRect(w.x + 10.5, w.y + 22.5, w.w - 34, 18);
    ctx.fillStyle = BLACK;
    ctx.font = this.font(11, true);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.calc.display.slice(0, 12), w.x + w.w - 30, w.y + 32);
    ctx.font = this.font(10);
    ctx.textAlign = 'center';
    const keys = this.calcKeys();
    keys.forEach((row, r) => {
      row.forEach((k, c) => {
        if (!k) return;
        const bw = k === '=' ? 52 : 24;
        const bx = w.x + 10 + c * 28;
        const by = w.y + 48 + r * 26;
        ctx.fillStyle = WHITE;
        ctx.fillRect(bx, by, bw, 20);
        ctx.strokeRect(bx + 0.5, by + 0.5, bw, 20);
        ctx.fillStyle = BLACK;
        ctx.fillText(k, bx + bw / 2, by + 10);
      });
    });
    ctx.textAlign = 'left';
  }

  private calcKeys(): (string | null)[][] {
    return [
      ['C', '±', '÷', '×'],
      ['7', '8', '9', '−'],
      ['4', '5', '6', '+'],
      ['1', '2', '3', null],
      ['0', '.', '=', null],
    ];
  }

  private calcPress(k: string): void {
    const c = this.calc;
    const apply = (): number => {
      const cur = parseFloat(c.display);
      if (c.acc === null || !c.op) return cur;
      const a = c.acc;
      if (c.op === '+') return a + cur;
      if (c.op === '−') return a - cur;
      if (c.op === '×') return a * cur;
      if (c.op === '÷') return cur === 0 ? NaN : a / cur;
      return cur;
    };
    if (k >= '0' && k <= '9') {
      c.display = c.fresh || c.display === '0' ? k : c.display + k;
      c.fresh = false;
    } else if (k === '.') {
      if (c.fresh) {
        c.display = '0.';
        c.fresh = false;
      } else if (!c.display.includes('.')) c.display += '.';
    } else if (k === 'C') {
      this.calc = { display: '0', acc: null, op: null, fresh: true };
    } else if (k === '±') {
      c.display = c.display.startsWith('-') ? c.display.slice(1) : '-' + c.display;
    } else if (k === '=') {
      const r = apply();
      c.display = Number.isNaN(r) ? 'Error' : String(Math.round(r * 1e9) / 1e9);
      c.acc = null;
      c.op = null;
      c.fresh = true;
    } else {
      const r = apply();
      c.acc = Number.isNaN(r) ? 0 : r;
      c.display = String(Math.round(r * 1e9) / 1e9);
      c.op = k;
      c.fresh = true;
    }
  }

  private calcClick(w: FinderWindow, x: number, y: number): boolean {
    const keys = this.calcKeys();
    for (let r = 0; r < keys.length; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        const k = keys[r][c];
        if (!k) continue;
        const bw = k === '=' ? 52 : 24;
        const bx = w.x + 10 + c * 28;
        const by = w.y + 48 + r * 26;
        if (x >= bx && x <= bx + bw && y >= by && y <= by + 20) {
          this.calcPress(k);
          return true;
        }
      }
    }
    return false;
  }

  private drawGuestApp(ctx: CanvasRenderingContext2D, w: FinderWindow): void {
    ctx.font = this.font(9);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#55534c';
    ctx.fillText('Sign the guestbook — type and press Enter', w.x + 12, w.y + 26);
    ctx.fillStyle = BLACK;
    const shown = this.guest.notes.slice(0, 7);
    shown.forEach((n, i) => {
      let s = n;
      while (ctx.measureText(s).width > w.w - 44 && s.length > 4) s = s.slice(0, -2);
      ctx.fillText(s === n ? s : s + '…', w.x + 12, w.y + 44 + i * 15);
    });
    // input line
    const iy = w.y + w.h - 34;
    ctx.strokeStyle = BLACK;
    ctx.strokeRect(w.x + 10.5, iy + 0.5, w.w - 34, 18);
    ctx.fillText(this.guest.draft, w.x + 16, iy + 9);
    const cw = ctx.measureText(this.guest.draft).width;
    ctx.fillRect(w.x + 17 + cw, iy + 3, 1.5, 12);
  }

  /** Physical keystrokes reach the guestbook when it is the front window. */
  handleKey(key: string): boolean {
    const front = this.frontWindow();
    if (front && front.app === 'web') {
      const web = this.web;
      if (web.typing) {
        if (key === 'Enter') {
          web.typing = false;
          const raw = web.input.trim();
          if (raw) {
            const ytQuery = /^yt:/i.test(raw)
              ? raw.replace(/^yt:\s*/i, '')
              : !raw.includes('.') && raw.includes(' ')
                ? raw
                : null;
            const url = ytQuery
              ? `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery)}`
              : /^[a-z]+:\/\//i.test(raw)
                ? raw
                : raw.includes('.')
                  ? `https://${raw}`
                  : `https://www.${raw}.com`; // bare word -> word.com
            this.webRequest(url);
          }
        } else if (key === 'Backspace') {
          web.input = web.input.slice(0, -1);
        } else if (key.length === 1 && web.input.length < 160) {
          web.input += key;
        } else {
          return false;
        }
        this.draw();
        return true;
      }
      if (key === 'ArrowUp') {
        this.webScrollBy(-40);
        return true;
      }
      if (key === 'ArrowDown') {
        this.webScrollBy(40);
        return true;
      }
      return false;
    }
    if (!front || front.app !== 'guestbook') return false;
    if (key === 'Enter') {
      const note = this.guest.draft.trim();
      if (note) {
        this.guest.notes.unshift(note);
        this.guest.notes = this.guest.notes.slice(0, 50);
        try {
          localStorage.setItem('mac128k-guestbook', JSON.stringify(this.guest.notes));
        } catch {
          /* fine */
        }
        if (this.onGuestNote) this.onGuestNote(note);
      }
      this.guest.draft = '';
    } else if (key === 'Backspace') {
      this.guest.draft = this.guest.draft.slice(0, -1);
    } else if (key.length === 1 && this.guest.draft.length < 44) {
      this.guest.draft += key;
    } else {
      return false;
    }
    this.draw();
    return true;
  }

  // ---------- MacWeb ----------

  /** Built-in start page, no network needed. */
  webHome(): void {
    const web = this.web;
    web.url = 'macweb://welcome';
    web.title = 'Welcome to MacWeb';
    web.links = [
      'https://ryandsouza.me',
      'https://www.youtube.com/results?search_query=macintosh+1984+commercial',
    ];
    web.blocks = [
      { style: 'h', runs: [{ text: 'Welcome to MacWeb' }] },
      { style: 'p', runs: [{ text: 'A text-only browser for a 1984 machine. Click the address bar, type a URL on your keyboard and press Enter. Underlined words are links.' }] },
      { style: 'p', runs: [{ text: 'Some places to visit:' }] },
      { style: 'li', runs: [{ text: 'ryandsouza.me', link: 0 }] },
      { style: 'li', runs: [{ text: 'YouTube: the 1984 commercial', link: 1 }] },
    ];
    web.scroll = 0;
    web.error = '';
    web.loading = false;
    web.video = null;
  }

  /** Navigate, keeping history for the back button. */
  private webRequest(url: string, push = true): void {
    if (push && this.web.url) this.web.history.push(this.web.url);
    if (this.web.history.length > 40) this.web.history.shift();
    if (url === 'macweb://welcome') {
      this.webHome();
      this.draw();
      return;
    }
    if (this.onWebNavigate) this.onWebNavigate(url);
    else this.webError('no network layer');
  }

  webLoading(url: string): void {
    this.web.loading = true;
    this.web.error = '';
    this.web.url = url;
    this.web.video = null;
    this.draw();
  }

  /** Switch MacWeb to video mode for a YouTube watch page. */
  webShowVideo(id: string, url: string): void {
    const web = this.web;
    web.video = { id };
    web.url = url;
    web.title = 'YouTube';
    web.blocks = [];
    web.links = [];
    web.loading = false;
    web.error = '';
    web.scroll = 0;
    this.draw();
  }

  /** Fill in the rest of the video page (title/description/related) while
   *  the given video keeps playing in place. */
  webVideoPage(id: string, title: string, blocks: WebBlock[], links: string[]): void {
    if (!this.web.video || this.web.video.id !== id) return;
    this.web.title = title;
    this.web.blocks = blocks;
    this.web.links = links;
    this.draw();
  }

  /** 16:9 video area at the top of the page flow (before scroll offset). */
  webVideoRect(w: FinderWindow): { x: number; y: number; w: number; h: number } {
    const availW = w.w - 30;
    const vh = Math.min(150, (availW * 9) / 16);
    const vw = (vh * 16) / 9;
    return { x: w.x + 10 + (availW - vw) / 2, y: w.y + 48, w: vw, h: vh };
  }

  /** Content clip area of the MacWeb window (matches drawWebApp's clip). */
  webContentRect(w: FinderWindow): { x: number; y: number; w: number; h: number } {
    return { x: w.x + 2, y: w.y + 42, w: w.w - 16, h: w.h - 42 - 15 };
  }

  webLoaded(title: string, blocks: WebBlock[], links: string[], finalUrl: string): void {
    const web = this.web;
    web.loading = false;
    web.error = '';
    web.title = title;
    web.blocks = blocks;
    web.links = links;
    web.url = finalUrl;
    web.scroll = 0;
    this.draw();
  }

  webError(msg: string): void {
    this.web.loading = false;
    this.web.error = msg;
    this.draw();
  }

  private webScrollBy(dy: number): void {
    const win = this.state.windows.find((w) => w.id === 'win-web');
    const viewH = win ? win.h - 44 - 14 : 200;
    const max = Math.max(0, this.web.contentH - viewH + 16);
    this.web.scroll = Math.max(0, Math.min(max, this.web.scroll + dy));
    this.draw();
  }

  /** Wheel over the open MacWeb window scrolls the page; returns handled. */
  webWheel(x: number, y: number, deltaY: number): boolean {
    const front = this.frontWindow();
    if (!front || front.app !== 'web') return false;
    if (x < front.x || x > front.x + front.w || y < front.y || y > front.y + front.h) return false;
    this.webScrollBy(deltaY * 0.5);
    return true;
  }

  /** Escape cancels URL typing (camera stays put); returns handled. */
  consumeEscape(): boolean {
    if (this.web.typing && this.frontWindow()?.app === 'web') {
      this.web.typing = false;
      this.draw();
      return true;
    }
    return false;
  }

  private drawWebApp(ctx: CanvasRenderingContext2D, w: FinderWindow): void {
    const web = this.web;
    this.webLinkRects = [];
    ctx.textBaseline = 'middle';
    // back button
    ctx.strokeStyle = BLACK;
    ctx.fillStyle = BLACK;
    ctx.strokeRect(w.x + 8.5, w.y + 22.5, 17, 15);
    ctx.beginPath();
    ctx.moveTo(w.x + 21, w.y + 26);
    ctx.lineTo(w.x + 13, w.y + 30);
    ctx.lineTo(w.x + 21, w.y + 34);
    ctx.closePath();
    ctx.fill();
    // address bar
    const barX = w.x + 30;
    const barW = w.w - 30 - 12;
    ctx.strokeRect(barX + 0.5, w.y + 22.5, barW, 15);
    ctx.save();
    ctx.beginPath();
    ctx.rect(barX + 3, w.y + 23, barW - 6, 14);
    ctx.clip();
    ctx.font = this.font(9);
    ctx.fillStyle = BLACK;
    const shown = web.typing ? `${web.input}_` : web.url || 'click here, type a URL, press Enter';
    ctx.fillStyle = web.typing || web.url ? BLACK : '#7a776d';
    const tw = ctx.measureText(shown).width;
    ctx.fillText(shown, Math.min(barX + 5, barX + barW - 8 - tw), w.y + 30.5);
    ctx.restore();

    // content
    const top = w.y + 44;
    const left = w.x + 10;
    const right = w.x + w.w - 20;
    const bottom = w.y + w.h - 15;
    ctx.save();
    ctx.beginPath();
    ctx.rect(w.x + 2, top - 2, w.w - 16, bottom - top + 2);
    ctx.clip();
    ctx.fillStyle = BLACK;
    let blockTopPad = 0;
    if (web.video) {
      // black frame in the page flow; tube.ts pins the real embed onto it
      const r = this.webVideoRect(w);
      const ry = r.y - web.scroll;
      ctx.fillRect(r.x, ry, r.w, r.h);
      ctx.fillStyle = WHITE;
      ctx.beginPath();
      ctx.moveTo(r.x + r.w / 2 - 8, ry + r.h / 2 - 10);
      ctx.lineTo(r.x + r.w / 2 + 12, ry + r.h / 2);
      ctx.lineTo(r.x + r.w / 2 - 8, ry + r.h / 2 + 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = BLACK;
      blockTopPad = r.y - (top + 10) + r.h + 14;
    }
    if (web.loading) {
      ctx.font = this.font(9);
      let host = web.url;
      try {
        host = new URL(web.url).hostname;
      } catch {
        /* keep raw */
      }
      ctx.fillText(`Connecting to ${host}…`, left, top + 24);
    } else if (web.error) {
      ctx.font = this.font(10, true);
      ctx.fillText('Cannot open page', left, top + 20);
      ctx.font = this.font(9);
      ctx.fillText(web.error, left, top + 36);
    } else {
      let yy = top + 10 + blockTopPad - web.scroll;
      for (const block of web.blocks) {
        const isH = block.style === 'h';
        const lineH = isH ? 16 : 12;
        ctx.font = this.font(isH ? 11 : 9, isH);
        const indent = block.style === 'li' ? 14 : 0;
        if (block.style === 'li' && yy > top - lineH && yy < bottom + lineH) {
          ctx.fillText('•', left + 3, yy);
        }
        let cx = left + indent;
        for (const run of block.runs) {
          const words = run.text.split(/\s+/).filter((s) => s.length);
          for (const word of words) {
            const ww = ctx.measureText(word).width;
            if (cx + ww > right && cx > left + indent) {
              cx = left + indent;
              yy += lineH;
            }
            if (yy > top - lineH && yy < bottom + lineH) {
              ctx.fillText(word, cx, yy);
              if (run.link !== undefined) {
                ctx.fillRect(cx, yy + 5, ww, 1);
                this.webLinkRects.push({ x: cx, y: yy - 6, w: ww + 4, h: 12, link: run.link });
              }
            }
            cx += ww + ctx.measureText(' ').width;
          }
        }
        yy += lineH + (isH ? 6 : 4);
      }
      web.contentH = yy + web.scroll - top;
      if (!web.blocks.length && !web.video) {
        ctx.font = this.font(9);
        ctx.fillText('Blank page.', left, top + 24);
      }
    }
    ctx.restore();
  }

  private webClick(w: FinderWindow, x: number, y: number): boolean {
    const web = this.web;
    // back
    if (x >= w.x + 8 && x <= w.x + 26 && y >= w.y + 22 && y <= w.y + 38) {
      const prev = web.history.pop();
      if (prev) this.webRequest(prev, false);
      return true;
    }
    // address bar focuses typing
    if (x >= w.x + 30 && x <= w.x + w.w - 12 && y >= w.y + 22 && y <= w.y + 38) {
      web.typing = true;
      web.input = '';
      return true;
    }
    // scroll arrows on the right chrome
    if (x >= w.x + w.w - 14) {
      if (y <= w.y + 44) {
        this.webScrollBy(-48);
        return true;
      }
      if (y >= w.y + w.h - 34) {
        this.webScrollBy(48);
        return true;
      }
    }
    // links
    for (const r of this.webLinkRects) {
      if (x >= r.x - 2 && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        const target = web.links[r.link];
        if (target) this.webRequest(target);
        return true;
      }
    }
    return true; // clicks inside the window shouldn't fall through
  }

  private drawAboutApp(ctx: CanvasRenderingContext2D, w: FinderWindow): void {
    ctx.font = this.font(10, true);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = BLACK;
    ctx.fillText('Ryan Dsouza', w.x + 14, w.y + 28);
    ctx.font = this.font(9);
    const lines = [
      'Multi-Disciplinary Designer',
      '',
      'I built this Macintosh to show',
      'my skills, using Figma and',
      'Claude Code.',
      '',
      'The screen you are reading is',
      'a live 1-bit canvas.',
      '',
      'Try MacPaint, the Puzzle and',
      'listen to songs in Music.',
      '',
      'If you liked what you saw,',
      'checkout my portfolio.',
    ];
    lines.forEach((l, i) => ctx.fillText(l, w.x + 14, w.y + 46 + i * 13));
    // link
    const ly = w.y + 46 + lines.length * 13 + 6;
    ctx.fillText('→ ryandsouza.me', w.x + 14, ly);
    const lw = ctx.measureText('→ ryandsouza.me').width;
    ctx.fillRect(w.x + 14, ly + 6, lw, 1);
  }

  private aboutClick(w: FinderWindow, x: number, y: number): boolean {
    const ly = w.y + 46 + 14 * 13 + 6;
    if (y >= ly - 8 && y <= ly + 10 && x >= w.x + 14 && x <= w.x + 130) {
      window.open('https://ryandsouza.me', '_blank', 'noopener');
      return true;
    }
    return false;
  }

  private appClick(w: FinderWindow, x: number, y: number): boolean {
    if (w.app === 'paint') return this.paintClick(w, x, y, false);
    if (w.app === 'puzzle') return this.puzzleClick(w, x, y);
    if (w.app === 'calc') return this.calcClick(w, x, y);
    if (w.app === 'about') return this.aboutClick(w, x, y);
    if (w.app === 'web') return this.webClick(w, x, y);
    return w.app === 'guestbook'; // clicking focuses it (front already)
  }

  private drawArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, dir: string): void {
    ctx.save();
    ctx.translate(cx, cy);
    if (dir === 'down') ctx.rotate(Math.PI);
    if (dir === 'left') ctx.rotate(-Math.PI / 2);
    if (dir === 'right') ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(4, 1);
    ctx.lineTo(1.5, 1);
    ctx.lineTo(1.5, 4);
    ctx.lineTo(-1.5, 4);
    ctx.lineTo(-1.5, 1);
    ctx.lineTo(-4, 1);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawIcon(
    ctx: CanvasRenderingContext2D,
    kind: FinderIcon['kind'],
    cx: number,
    cy: number,
    label: string,
    selected: boolean,
  ): void {
    ctx.save();
    ctx.strokeStyle = BLACK;
    ctx.fillStyle = selected ? BLACK : WHITE;
    ctx.lineWidth = 1;
    if (kind === 'folder') {
      ctx.fillRect(cx - 12, cy - 8, 24, 16);
      ctx.strokeRect(cx - 11.5, cy - 7.5, 23, 15);
      ctx.strokeRect(cx - 11.5, cy - 10.5, 9, 3); // tab
    } else if (kind === 'doc') {
      this.drawPage(ctx, cx, cy, selected);
      ctx.beginPath(); // text lines
      ctx.strokeStyle = selected ? WHITE : BLACK;
      for (let i = -2; i <= 3; i += 1) {
        ctx.moveTo(cx - 5, cy + i * 2.5 - 1);
        ctx.lineTo(cx + 5, cy + i * 2.5 - 1);
      }
      ctx.stroke();
    } else if (kind === 'web') {
      // wireframe globe
      ctx.fillStyle = selected ? BLACK : WHITE;
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = selected ? WHITE : BLACK;
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx, cy, 3.6, 8, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy);
      ctx.lineTo(cx + 8, cy);
      ctx.moveTo(cx - 7, cy - 4);
      ctx.lineTo(cx + 7, cy - 4);
      ctx.moveTo(cx - 7, cy + 4);
      ctx.lineTo(cx + 7, cy + 4);
      ctx.stroke();
    } else if (kind === 'app') {
      this.drawPage(ctx, cx, cy, selected);
      // pencil-hand glyph approximation
      ctx.strokeStyle = selected ? WHITE : BLACK;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy + 5);
      ctx.lineTo(cx + 4, cy - 4);
      ctx.lineTo(cx + 6, cy - 2);
      ctx.lineTo(cx - 3, cy + 7);
      ctx.closePath();
      ctx.stroke();
    } else if (kind === 'music') {
      this.drawPage(ctx, cx, cy, selected);
      ctx.strokeStyle = selected ? WHITE : BLACK;
      ctx.fillStyle = selected ? WHITE : BLACK;
      // beamed eighth notes
      ctx.beginPath();
      ctx.ellipse(cx - 4, cy + 5, 2.4, 1.8, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 3, cy + 4, 2.4, 1.8, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cx - 2, cy + 5);
      ctx.lineTo(cx - 2, cy - 4);
      ctx.lineTo(cx + 5, cy - 5.5);
      ctx.lineTo(cx + 5, cy + 4);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else if (kind === 'paint') {
      this.drawPage(ctx, cx, cy, selected);
      ctx.strokeStyle = selected ? WHITE : BLACK;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy + 6);
      ctx.quadraticCurveTo(cx - 2, cy - 4, cx + 2, cy + 2);
      ctx.quadraticCurveTo(cx + 5, cy + 6, cx + 6, cy - 5);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else if (kind === 'puzzle') {
      ctx.fillRect(cx - 9, cy - 9, 18, 18);
      ctx.strokeRect(cx - 8.5, cy - 8.5, 17, 17);
      ctx.strokeStyle = selected ? WHITE : BLACK;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 8.5);
      ctx.lineTo(cx, cy + 8.5);
      ctx.moveTo(cx - 8.5, cy);
      ctx.lineTo(cx + 8.5, cy);
      ctx.stroke();
    } else if (kind === 'calc') {
      ctx.fillRect(cx - 7, cy - 10, 14, 20);
      ctx.strokeRect(cx - 6.5, cy - 9.5, 13, 19);
      ctx.strokeStyle = selected ? WHITE : BLACK;
      ctx.strokeRect(cx - 4.5, cy - 7.5, 9, 4);
      ctx.fillStyle = selected ? WHITE : BLACK;
      for (let ry = 0; ry < 2; ry += 1)
        for (let rx = 0; rx < 3; rx += 1) ctx.fillRect(cx - 4 + rx * 4, cy - 1 + ry * 4, 2, 2);
    } else if (kind === 'book') {
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6);
      ctx.quadraticCurveTo(cx - 5, cy - 9, cx - 10, cy - 6);
      ctx.lineTo(cx - 10, cy + 7);
      ctx.quadraticCurveTo(cx - 5, cy + 4, cx, cy + 7);
      ctx.quadraticCurveTo(cx + 5, cy + 4, cx + 10, cy + 7);
      ctx.lineTo(cx + 10, cy - 6);
      ctx.quadraticCurveTo(cx + 5, cy - 9, cx, cy - 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = selected ? WHITE : BLACK;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx, cy + 7);
      ctx.stroke();
    } else if (kind === 'trash') {
      ctx.fillRect(cx - 8, cy - 7, 16, 15);
      ctx.strokeRect(cx - 7.5, cy - 6.5, 15, 14);
      ctx.strokeRect(cx - 9.5, cy - 9.5, 19, 3); // lid
      ctx.strokeRect(cx - 2.5, cy - 11.5, 5, 2); // handle
      ctx.beginPath();
      for (let i = -4; i <= 4; i += 4) {
        ctx.moveTo(cx + i, cy - 4);
        ctx.lineTo(cx + i, cy + 5);
      }
      ctx.stroke();
    } else if (kind === 'disk') {
      ctx.fillRect(cx - 12, cy - 7, 24, 14);
      ctx.strokeRect(cx - 11.5, cy - 6.5, 23, 13);
      ctx.fillStyle = selected ? WHITE : BLACK;
      ctx.fillRect(cx - 8, cy - 3, 16, 2);
    } else if (kind === 'floppy') {
      ctx.fillRect(cx - 9, cy - 8, 18, 16);
      ctx.strokeRect(cx - 8.5, cy - 7.5, 17, 15);
      ctx.strokeRect(cx - 4.5, cy - 7.5, 8, 5); // shutter
      ctx.strokeRect(cx - 5.5, cy + 1.5, 11, 5); // label
    }
    ctx.restore();
    // label
    ctx.save();
    ctx.font = this.font(9);
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = selected ? BLACK : 'rgba(238,238,236,0.9)';
    ctx.fillRect(cx - tw / 2 - 1, cy + 9, tw + 2, 10);
    ctx.fillStyle = selected ? WHITE : BLACK;
    ctx.fillText(label, cx - tw / 2, cy + 10);
    ctx.restore();
  }

  private drawPage(ctx: CanvasRenderingContext2D, cx: number, cy: number, selected: boolean): void {
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 10);
    ctx.lineTo(cx + 3, cy - 10);
    ctx.lineTo(cx + 8, cy - 5);
    ctx.lineTo(cx + 8, cy + 10);
    ctx.lineTo(cx - 8, cy + 10);
    ctx.closePath();
    ctx.fillStyle = selected ? BLACK : WHITE;
    ctx.fill();
    ctx.strokeStyle = BLACK;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 3, cy - 10);
    ctx.lineTo(cx + 3, cy - 5);
    ctx.lineTo(cx + 8, cy - 5);
    ctx.stroke();
  }

  private drawDesktopIcon(
    ctx: CanvasRenderingContext2D,
    kind: FinderIcon['kind'],
    label: string,
    cx: number,
    cy: number,
    selected: boolean,
  ): void {
    this.drawIcon(ctx, kind, cx, cy, label, selected);
  }

  private drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 12);
    ctx.lineTo(3, 9);
    ctx.lineTo(5.5, 14);
    ctx.lineTo(7.5, 13);
    ctx.lineTo(5, 8);
    ctx.lineTo(9, 8);
    ctx.closePath();
    ctx.fillStyle = BLACK;
    ctx.fill();
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ---------- interaction ----------

  frontWindow(): FinderWindow | null {
    return this.state.windows[this.state.windows.length - 1] ?? null;
  }

  private windowAt(x: number, y: number): FinderWindow | null {
    for (let i = this.state.windows.length - 1; i >= 0; i -= 1) {
      const w = this.state.windows[i];
      if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w;
    }
    return null;
  }

  moveCursor(x: number, y: number): void {
    this.state.cursor.x = x;
    this.state.cursor.y = y;
    if (this.state.openMenu !== null) {
      const menu = MENUS[this.state.openMenu];
      const mx = MENU_XS[this.state.openMenu].x;
      const w = this.state.openMenu === 0 ? 130 : 96;
      const itemH = 14;
      if (x >= mx - 4 && x <= mx - 4 + w && y >= 20 && y <= 20 + menu.items.length * itemH + 4) {
        this.state.hoverMenuItem = Math.max(0, Math.min(menu.items.length - 1, Math.floor((y - 22) / itemH)));
      } else {
        this.state.hoverMenuItem = null;
      }
    }
    this.draw();
  }

  private dragTarget: { win: FinderWindow; dx: number; dy: number } | null = null;

  pointerDown(x: number, y: number): void {
    const s = this.state;
    // menu bar
    if (y <= 19) {
      const idx = MENU_XS.findIndex((m) => x >= m.x - 4 && x <= m.x - 4 + m.w);
      s.openMenu = idx >= 0 ? idx : null;
      s.hoverMenuItem = null;
      this.draw();
      return;
    }
    if (s.openMenu !== null) {
      this.menuAction(s.openMenu, s.hoverMenuItem);
      s.openMenu = null;
      s.hoverMenuItem = null;
      this.draw();
      return;
    }
    const win = this.windowAt(x, y);
    if (win) {
      // bring to front
      const arr = s.windows;
      arr.splice(arr.indexOf(win), 1);
      arr.push(win);
      // close box
      if (x >= win.x + 6 && x <= win.x + 19 && y >= win.y + 2 && y <= win.y + 16) {
        arr.pop();
        this.draw();
        return;
      }
      // title bar drag
      if (y <= win.y + 16) {
        this.dragTarget = { win, dx: x - win.x, dy: y - win.y };
        this.draw();
        return;
      }
      // player content
      if (win.player) {
        this.musicClick(win, x, y);
        this.draw();
        return;
      }
      // app content
      if (win.app) {
        // dragging in MacWeb content scrolls the page (touch-friendly)
        if (win.app === 'web' && y > win.y + 40) this.webScrollDrag = y;
        this.appClick(win, x, y);
        this.draw();
        return;
      }
      // icon click -> select + arm drag
      const icon = win.icons.find(
        (ic) => Math.abs(x - (win.x + ic.x)) <= 16 && Math.abs(y - (win.y + ic.y)) <= 14,
      );
      s.selectedIcon = icon ? icon.id : null;
      if (icon && win.id !== 'win-trash') {
        this.iconDrag = {
          win,
          icon,
          dx: x - (win.x + icon.x),
          dy: y - (win.y + icon.y),
          ox: icon.x,
          oy: icon.y,
          moved: false,
        };
      }
      this.draw();
      return;
    }
    // desktop icons -> select + arm drag
    const deskId = this.desktopIconAt(x, y);
    s.selectedIcon = deskId;
    if (deskId) {
      const di = this.deskIcons.find((d) => d.id === deskId)!;
      this.iconDrag = { win: null, icon: di, dx: x - di.x, dy: y - di.y, ox: di.x, oy: di.y, moved: false };
    }
    this.draw();
  }

  pointerDrag(x: number, y: number): void {
    if (this.painting) {
      const front = this.frontWindow();
      if (front && front.app === 'paint') this.paintClick(front, x, y, true);
      this.moveCursor(x, y);
      return;
    }
    if (this.iconDrag) {
      const d = this.iconDrag;
      d.moved = true;
      if (d.win) {
        d.icon.x = Math.max(16, Math.min(d.win.w - 30, x - d.win.x - d.dx));
        d.icon.y = Math.max(30, Math.min(d.win.h - 30, y - d.win.y - d.dy));
      } else {
        d.icon.x = Math.max(20, Math.min(SCREEN_W - 12, x - d.dx));
        d.icon.y = Math.max(32, Math.min(SCREEN_H - 20, y - d.dy));
      }
      this.moveCursor(x, y);
      return;
    }
    if (this.dragTarget) {
      const { win, dx, dy } = this.dragTarget;
      win.x = Math.max(-win.w + 40, Math.min(SCREEN_W - 40, x - dx));
      win.y = Math.max(20, Math.min(SCREEN_H - 24, y - dy));
    } else if (this.webScrollDrag !== null && this.frontWindow()?.app === 'web') {
      const dy = this.webScrollDrag - y;
      if (dy !== 0) this.webScrollBy(dy);
      this.webScrollDrag = y;
    }
    this.moveCursor(x, y);
  }

  pointerUp(): void {
    this.dragTarget = null;
    this.painting = false;
    this.lastPaint = null;
    this.webScrollDrag = null;
    const d = this.iconDrag;
    this.iconDrag = null;
    if (!d || !d.moved) return;
    const trash = this.deskIcons.find((di) => di.id === 'trash');
    if (!trash) {
      this.draw();
      return;
    }
    if (d.win) {
      // window icon dropped on the Trash -> it moves to the Trash window
      const wx = d.win.x + d.icon.x;
      const wy = d.win.y + d.icon.y;
      const overTrash =
        Math.abs(this.state.cursor.x - trash.x) <= 24 && Math.abs(this.state.cursor.y - trash.y) <= 20;
      void wx;
      void wy;
      if (overTrash && 'kind' in d.icon) {
        const win = d.win;
        const icon = d.icon as FinderIcon;
        win.icons.splice(win.icons.indexOf(icon), 1);
        icon.x = 50 + (this.trashed.length % 5) * 70;
        icon.y = 60 + Math.floor(this.trashed.length / 5) * 55;
        this.trashed.push(icon);
        this.state.selectedIcon = null;
      }
    } else if (d.icon.id !== 'trash') {
      const overTrash = Math.abs(d.icon.x - trash.x) <= 30 && Math.abs(d.icon.y - trash.y) <= 26;
      if (overTrash) {
        const di = this.deskIcons.find((x) => x.id === d.icon.id)!;
        if (di.kind === 'disk' || di.kind === 'floppy') {
          // disks cannot be trashed: snap back
          d.icon.x = d.ox;
          d.icon.y = d.oy;
        } else {
          this.deskIcons.splice(this.deskIcons.indexOf(di), 1);
          this.trashed.push({
            id: di.id,
            label: di.label,
            kind: di.kind,
            x: 50 + (this.trashed.length % 5) * 70,
            y: 60 + Math.floor(this.trashed.length / 5) * 55,
          });
          this.state.selectedIcon = null;
        }
      }
    }
    this.draw();
  }

  private desktopIconAt(x: number, y: number): string | null {
    for (const di of this.deskIcons) {
      if (Math.abs(x - di.x) <= 20 && Math.abs(y - di.y) <= 16) return di.id;
    }
    return null;
  }

  openDesktopIcon(id: string): void {
    const s = this.state;
    const front = (w: FinderWindow) => {
      s.windows.splice(s.windows.indexOf(w), 1);
      s.windows.push(w);
    };
    if (id === 'desk-disk') {
      const existing = s.windows.find((w) => w.id === 'system-disk');
      if (existing) front(existing);
      else s.windows.push(systemDiskWindow());
    } else if (id === 'desk-floppy') {
      const existing = s.windows.find((w) => w.id === 'win-my-disk');
      if (existing) front(existing);
      else
        s.windows.push({
          id: 'win-my-disk',
          title: 'My Disk',
          x: 90,
          y: 70,
          w: 300,
          h: 150,
          info: '0 items     0K in disk     400K available',
          icons: [],
        });
    } else if (id === 'trash') {
      const existing = s.windows.find((w) => w.id === 'win-trash');
      if (existing) {
        existing.icons = this.trashed;
        existing.info = `${this.trashed.length} item${this.trashed.length === 1 ? '' : 's'} in trash`;
        front(existing);
      } else
        s.windows.push({
          id: 'win-trash',
          title: 'Trash',
          x: 130,
          y: 80,
          w: 300,
          h: 170,
          info: `${this.trashed.length} item${this.trashed.length === 1 ? '' : 's'} in trash`,
          icons: this.trashed,
        });
    } else {
      // app/document icons living on the desktop launch like window icons
      const di = this.deskIcons.find((d) => d.id === id);
      if (di) this.openIcon({ id: di.id, label: di.label, kind: di.kind, x: di.x, y: di.y });
    }
    this.draw();
  }

  doubleClick(x: number, y: number): void {
    const win = this.windowAt(x, y);
    const icon = win
      ? win.icons.find((ic) => Math.abs(x - (win.x + ic.x)) <= 16 && Math.abs(y - (win.y + ic.y)) <= 14)
      : null;
    if (icon) {
      this.openIcon(icon);
      return;
    }
    if (!win) {
      const desk = this.desktopIconAt(x, y);
      if (desk) this.openDesktopIcon(desk);
    }
  }

  private openIcon(icon: FinderIcon): void {
    const s = this.state;
    const launch = (id: string, title: string, app: FinderWindow['app'], w: number, h: number): void => {
      const existing = s.windows.find((win) => win.id === id);
      if (existing) {
        s.windows.splice(s.windows.indexOf(existing), 1);
        s.windows.push(existing);
      } else {
        s.windows.push({
          id,
          title,
          x: 60 + ((s.windows.length * 24) % 120),
          y: 30 + ((s.windows.length * 14) % 60),
          w,
          h,
          info: null,
          icons: [],
          app,
        });
      }
      this.draw();
    };
    if (icon.id === 'about-ryan') {
      launch('win-about', 'About Ryan', 'about', 250, 282);
      return;
    }
    if (icon.id === 'macpaint') {
      launch('win-paint', 'MacPaint', 'paint', 300, 216);
      return;
    }
    if (icon.id === 'puzzle') {
      launch('win-puzzle', 'Puzzle', 'puzzle', 148, 184);
      return;
    }
    if (icon.id === 'calculator') {
      launch('win-calc', 'Calculator', 'calc', 146, 196);
      return;
    }
    if (icon.id === 'guestbook') {
      launch('win-guest', 'Guestbook', 'guestbook', 320, 194);
      return;
    }
    if (icon.id === 'macweb') {
      launch('win-web', 'MacWeb', 'web', 400, 290);
      const ww = s.windows.find((win) => win.id === 'win-web')!;
      ww.x = Math.min(ww.x, SCREEN_W - ww.w - 8);
      ww.y = Math.min(ww.y, 34);
      if (!this.web.blocks.length) this.webHome();
      this.draw();
      return;
    }
    if (icon.id === 'music') {
      const existing = s.windows.find((w) => w.id === 'win-music');
      if (existing) {
        s.windows.splice(s.windows.indexOf(existing), 1);
        s.windows.push(existing);
      } else {
        s.windows.push({
          id: 'win-music',
          title: 'Music',
          x: 92,
          y: 36,
          w: 336,
          h: 252,
          info: null,
          icons: [],
          player: true,
        });
      }
      this.draw();
      return;
    }
    const existing = s.windows.find((w) => w.id === `win-${icon.id}`);
    if (existing) {
      s.windows.splice(s.windows.indexOf(existing), 1);
      s.windows.push(existing);
      this.draw();
      return;
    }
    if (icon.kind === 'folder') {
      s.windows.push({
        id: `win-${icon.id}`,
        title: icon.label,
        x: 100 + s.windows.length * 18,
        y: 60 + s.windows.length * 14,
        w: 260,
        h: 140,
        info: icon.id === 'system-folder' ? '2 items     148K in disk     201K available' : '0 items     0K in disk     201K available',
        icons:
          icon.id === 'system-folder'
            ? [
                { id: 'sys-file', label: 'System', kind: 'doc', x: 60, y: 60 },
                { id: 'finder-file', label: 'Finder', kind: 'app', x: 140, y: 60 },
              ]
            : [],
      });
    } else {
      s.windows.push({
        id: `win-${icon.id}`,
        title: icon.kind === 'app' ? 'TeachText' : 'A document',
        x: 110 + s.windows.length * 18,
        y: 64 + s.windows.length * 14,
        w: 280,
        h: 150,
        info: null,
        icons: [],
        text:
          icon.kind === 'app'
            ? ['', 'Welcome to Macintosh.', '', 'This procedural Macintosh 128K was', 'sculpted entirely in Three.js code.', '', 'Try the menus. Drag this window.']
            : ['', 'A document.', '', 'Every pixel of this screen is a live', 'canvas texture on the CRT panel.'],
      });
    }
    this.draw();
  }

  private menuAction(menuIndex: number, itemIndex: number | null): void {
    if (itemIndex === null) return;
    const s = this.state;
    const menu = MENUS[menuIndex];
    const item = menu.items[itemIndex];
    if (!item || !item.enabled) return;
    if (menu.title === 'File' && item.label === 'Close') s.windows.pop();
    if (menu.title === 'File' && item.label === 'Close All') s.windows.length = 0;
    if (menu.title === 'File' && item.label === 'Open') {
      if (s.selectedIcon && ['desk-disk', 'desk-floppy', 'trash'].includes(s.selectedIcon)) {
        this.openDesktopIcon(s.selectedIcon);
      } else {
        const front = this.frontWindow();
        const sel = front?.icons.find((ic) => ic.id === s.selectedIcon);
        if (sel) this.openIcon(sel);
      }
    }
    if (menu.title === 'Special' && item.label === 'Empty Trash') {
      this.trashed.length = 0;
      const tw = s.windows.find((w) => w.id === 'win-trash');
      if (tw) tw.info = '0 items in trash';
    }
    if (menu.title === 'Special' && item.label === 'Shut Down') {
      s.windows.length = 0;
      s.selectedIcon = null;
      s.openMenu = null;
      if (this.onShutDown) this.onShutDown();
      return;
    }
    if (menu.title === 'Special' && item.label === 'Clean Up') {
      const front = this.frontWindow();
      if (front) {
        front.icons.forEach((ic, i) => {
          ic.x = 60 + (i % 4) * 80;
          ic.y = 60 + Math.floor(i / 4) * 60;
        });
      }
    }
    if (menuIndex === 0) {
      s.windows.push({
        id: `win-about-${Date.now()}`,
        title: 'About the Finder',
        x: 120,
        y: 90,
        w: 270,
        h: 120,
        info: null,
        icons: [],
        text: ['', 'The Macintosh Finder', 'Version 1.0 (procedural)', '', 'Sculpted in Three.js — 1984 on a canvas.'],
      });
    }
  }
}
