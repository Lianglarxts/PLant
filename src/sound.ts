/**
 * Soft ambient soundscape, synthesised with Web Audio (no audio files). Muted until turned on.
 *
 *  - beds: continuous rain and wind noise that fade in and out with the weather
 *  - birds by day, crickets at night, scattered left/right with a little reverb
 *  - gentle pentatonic chimes for growth, a soft "bloop" for seed pods, a tiny arpeggio for discoveries
 *
 * Everything goes through a shared reverb and a soft compressor so nothing is sharp or loud.
 */
export interface SoundState {
  light: number; // 0 night .. 1 day
  rain: number; // 0..1 (weather rain or a rain cloud overhead)
  wind: number; // 0..1
  snow: number; // 0..1
}

// C major pentatonic, two octaves up from C5
const PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];

export class Sound {
  on = false;
  private ac: AudioContext | null = null;
  private dry: GainNode | null = null; // into the compressor
  private wet: GainNode | null = null; // into the reverb
  private rainGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private white: AudioBuffer | null = null;
  private lastGrow = 0;
  private nextBird = 0;
  private nextCricket = 0;
  private nextDrip = 0;
  private lastNote = -1;
  private state: SoundState = { light: 1, rain: 0, wind: 0, snow: 0 };

  setOn(v: boolean) {
    this.on = v;
    if (v) this.wake();
    else if (this.ac && this.ac.state === 'running') void this.ac.suspend();
  }

  /** Must be called from a user gesture at least once (browser autoplay rules). */
  wake() {
    if (!this.on) return;
    try {
      if (!this.ac) this.build();
      if (this.ac && this.ac.state === 'suspended') void this.ac.resume();
    } catch {
      this.ac = null;
    }
  }

  private build() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new AC();
    this.ac = ac;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 3;
    const master = ac.createGain();
    master.gain.value = 0.8;
    comp.connect(master).connect(ac.destination);
    this.dry = ac.createGain();
    this.dry.connect(comp);
    // a soft, airy reverb made from decaying noise
    const verb = ac.createConvolver();
    const len = Math.floor(ac.sampleRate * 2.6);
    const ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    verb.buffer = ir;
    this.wet = ac.createGain();
    this.wet.gain.value = 0.35;
    this.wet.connect(verb).connect(comp);

    // noise sources for the beds
    const n = ac.sampleRate * 3;
    this.white = ac.createBuffer(1, n, ac.sampleRate);
    const w = this.white.getChannelData(0);
    for (let i = 0; i < n; i++) w[i] = Math.random() * 2 - 1;
    const brown = ac.createBuffer(1, n, ac.sampleRate);
    const b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      b[i] = last * 3.5;
    }

    // rain: a soft hiss, band-limited so it sounds like a shower, not static
    const rainSrc = ac.createBufferSource();
    rainSrc.buffer = this.white;
    rainSrc.loop = true;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 500;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2800;
    this.rainGain = ac.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(hp).connect(lp).connect(this.rainGain).connect(this.dry);
    rainSrc.start();

    // wind / air: deep brown noise with a slowly moving filter
    const windSrc = ac.createBufferSource();
    windSrc.buffer = brown;
    windSrc.loop = true;
    this.windFilter = ac.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 380;
    this.windFilter.Q.value = 0.7;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ac.createGain();
    lfoAmt.gain.value = 160;
    lfo.connect(lfoAmt).connect(this.windFilter.frequency);
    lfo.start();
    this.windGain = ac.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.dry);
    windSrc.start();
  }

  private ready() {
    return !!(this.on && this.ac && this.dry && this.ac.state === 'running');
  }

  /** A short voice: oscillator → gain envelope → pan → dry + reverb. */
  private voice(type: OscillatorType, freq: number, t: number, attack: number, decay: number, vol: number, pan = 0, wet = 0.5) {
    const ac = this.ac!;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p);
    p.connect(this.dry!);
    const send = ac.createGain();
    send.gain.value = wet;
    p.connect(send).connect(this.wet!);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
    return o;
  }

  /** Soft chime when something grows: a random pentatonic note, never the same twice in a row. */
  grow() {
    if (!this.ready()) return;
    const t = this.ac!.currentTime;
    if (t - this.lastGrow < 0.35) return;
    this.lastGrow = t;
    let i = Math.floor(Math.random() * PENTA.length);
    if (i === this.lastNote) i = (i + 2) % PENTA.length;
    this.lastNote = i;
    const pan = Math.random() * 1.2 - 0.6;
    this.voice('sine', PENTA[i], t, 0.008, 1.6, 0.05, pan, 0.8);
    this.voice('sine', PENTA[i] * 2, t, 0.005, 0.5, 0.012, pan, 0.8);
  }

  /** Seed pod bursting: a soft rising bloop. */
  pop() {
    if (!this.ready()) return;
    const t = this.ac!.currentTime;
    const o = this.voice('sine', 260, t, 0.01, 0.22, 0.09, Math.random() * 0.6 - 0.3, 0.4);
    o.frequency.exponentialRampToValueAtTime(520, t + 0.12);
  }

  /** A little rising arpeggio for something new (book entry, new vase). */
  bloom() {
    if (!this.ready()) return;
    const t = this.ac!.currentTime;
    [0, 2, 4, 5].forEach((n, k) => this.voice('sine', PENTA[n], t + k * 0.12, 0.01, 1.4, 0.045, -0.3 + k * 0.2, 0.9));
  }

  /** One bird song phrase, chosen from a few simple patterns. */
  chirp(vol = 0.035) {
    if (!this.ready()) return;
    const ac = this.ac!;
    const t = ac.currentTime + 0.02;
    const pan = Math.random() * 1.6 - 0.8;
    const base = 2200 + Math.random() * 1600;
    const kind = Math.floor(Math.random() * 3);
    if (kind === 0) {
      // "tsee-tsee": a few quick up-glides
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const o = this.voice('sine', base, t + i * 0.16, 0.01, 0.09, vol, pan, 0.6);
        o.frequency.exponentialRampToValueAtTime(base * 1.4, t + i * 0.16 + 0.08);
      }
    } else if (kind === 1) {
      // a slow whistle that rises then falls, with a little vibrato
      const o = this.voice('sine', base * 0.8, t, 0.04, 0.5, vol * 0.9, pan, 0.7);
      o.frequency.linearRampToValueAtTime(base * 1.05, t + 0.18);
      o.frequency.linearRampToValueAtTime(base * 0.9, t + 0.45);
      const vib = ac.createOscillator();
      vib.frequency.value = 7;
      const va = ac.createGain();
      va.gain.value = base * 0.015;
      vib.connect(va).connect(o.frequency);
      vib.start(t);
      vib.stop(t + 0.6);
    } else {
      // a soft trill
      for (let i = 0; i < 7; i++) {
        const f = base * (1 + 0.06 * (i % 2));
        this.voice('sine', f, t + i * 0.055, 0.006, 0.05, vol * 0.7, pan, 0.6);
      }
    }
  }

  private cricket() {
    const t = this.ac!.currentTime;
    const pan = Math.random() * 1.6 - 0.8;
    for (let i = 0; i < 3; i++) this.voice('sine', 4300, t + i * 0.08, 0.01, 0.04, 0.012, pan, 0.5);
  }

  /** A single raindrop "tik" on a leaf. */
  private drip(vol: number) {
    const ac = this.ac!;
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = this.white;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800 + Math.random() * 2500;
    bp.Q.value = 6;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    const p = ac.createStereoPanner();
    p.pan.value = Math.random() * 1.8 - 0.9;
    src.connect(bp).connect(g).connect(p).connect(this.dry!);
    src.start(t, Math.random() * 2, 0.06);
  }

  /** Call every frame (real time in seconds). Fades the beds and scatters birds, crickets and drips. */
  update(now: number, s: SoundState) {
    this.state = s;
    if (!this.ready()) return;
    const ac = this.ac!;
    const t = ac.currentTime;
    // beds follow the weather slowly
    this.rainGain!.gain.setTargetAtTime(s.rain * 0.16, t, 1.2);
    const air = 0.012 + s.wind * 0.1 + s.snow * 0.02;
    this.windGain!.gain.setTargetAtTime(air, t, 1.5);
    this.windFilter!.Q.value = 0.7 + s.wind * 2;
    // scattered sounds
    if (s.rain > 0.15 && now > this.nextDrip) {
      this.nextDrip = now + 0.05 + Math.random() * (0.6 / s.rain);
      this.drip(0.05 * s.rain);
    }
    const quiet = s.rain > 0.4 || s.snow > 0.4;
    if (now > this.nextBird) {
      this.nextBird = now + 4 + Math.random() * 7;
      if (!quiet && s.light > 0.6) this.chirp();
    }
    if (now > this.nextCricket) {
      this.nextCricket = now + 1.5 + Math.random() * 4;
      if (!quiet && s.light < 0.3) this.cricket();
    }
  }
}
