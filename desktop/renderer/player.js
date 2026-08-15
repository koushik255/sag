import {
  ALL_FORMATS,
  AudioBufferSink,
  CanvasSink,
  CustomSource,
  Input,
} from 'mediabunny';
import { registerAc3Decoder } from '@mediabunny/ac3';

registerAc3Decoder();

function formatTime(value) {
  if (!Number.isFinite(value)) return '00:00';
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export class MediaPlayer {
  constructor(elements) {
    Object.assign(this, elements);
    this.context = this.canvas.getContext('2d');
    this.audioContext = null;
    this.input = null;
    this.gainNode = null;
    this.videoSink = null;
    this.audioSink = null;
    this.videoIterator = null;
    this.audioIterator = null;
    this.nextFrame = null;
    this.queuedAudio = new Set();
    this.firstTimestamp = 0;
    this.endTimestamp = 0;
    this.playbackTimeAtStart = 0;
    this.audioContextStartTime = null;
    this.playing = false;
    this.loaded = false;
    this.asyncId = 0;
    this.dragging = false;
    this.volumeValue = 0.7;

    this.playButton.addEventListener('click', () => this.toggle());
    this.timeline.addEventListener('pointerdown', () => { this.dragging = true; });
    this.timeline.addEventListener('input', () => {
      this.currentTime.textContent = formatTime(Number(this.timeline.value));
    });
    this.timeline.addEventListener('change', () => {
      this.dragging = false;
      void this.seek(Number(this.timeline.value));
    });
    this.volume.addEventListener('input', () => {
      this.volumeValue = Number(this.volume.value);
      this.updateVolume();
    });
    this.mute.addEventListener('click', () => {
      this.volumeValue = this.volumeValue === 0 ? 0.7 : 0;
      this.volume.value = String(this.volumeValue);
      this.updateVolume();
    });
    this.fullscreen.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void this.stage.requestFullscreen();
    });
    requestAnimationFrame(() => this.render());
  }

  async open(item) {
    await this.dispose();
    const openingId = ++this.asyncId;
    this.loaded = false;
    this.loading.hidden = false;
    this.error.hidden = true;
    this.warning.hidden = true;
    this.playButton.textContent = '▶';

    try {
      if (!Number.isSafeInteger(Number(item.size)) || Number(item.size) <= 0) {
        throw new Error('The server did not report a valid file size.');
      }
      const source = new CustomSource({
        getSize: () => Number(item.size),
        read: (start, end) => window.stopAndGo.readMedia({ url: item.url, start, end }),
        maxCacheSize: 32 * 1024 * 1024,
        prefetchProfile: 'network',
      });
      const input = new Input({
        source,
        formats: ALL_FORMATS,
      });
      this.input = input;
      let videoTrack = await input.getPrimaryVideoTrack();
      let audioTrack = await input.getPrimaryAudioTrack();
      const tracks = [videoTrack, audioTrack].filter(Boolean);
      if (openingId !== this.asyncId) return;

      this.firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0);
      this.endTimestamp = await input.getDurationFromMetadata(tracks, { skipLiveWait: true })
        ?? await input.computeDuration(tracks, { skipLiveWait: true });
      this.playbackTimeAtStart = this.firstTimestamp;

      const problems = [];
      const videoCodec = await videoTrack?.getCodec();
      const audioCodec = await audioTrack?.getCodec();
      if (videoTrack && (!videoCodec || !(await videoTrack.canDecode()))) {
        problems.push(`video ${videoCodec || item.video_codec || 'codec'} cannot be decoded on this computer`);
        videoTrack = null;
      }
      if (audioTrack && (!audioCodec || !(await audioTrack.canDecode()))) {
        problems.push(`audio ${audioCodec || item.audio_codec || 'codec'} cannot be decoded on this computer`);
        audioTrack = null;
      }
      if (!videoTrack && !audioTrack) {
        throw new Error(problems.join('; ') || 'No playable audio or video track was found.');
      }
      if (problems.length) {
        this.warning.textContent = problems.join('; ');
        this.warning.hidden = false;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass({ sampleRate: await audioTrack?.getSampleRate() });
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      this.updateVolume();

      this.videoSink = videoTrack ? new CanvasSink(videoTrack, { poolSize: 2, fit: 'contain' }) : null;
      this.audioSink = audioTrack ? new AudioBufferSink(audioTrack) : null;
      if (videoTrack) {
        this.canvas.hidden = false;
        this.canvas.width = await videoTrack.getDisplayWidth();
        this.canvas.height = await videoTrack.getDisplayHeight();
      } else {
        this.canvas.hidden = true;
      }

      this.timeline.min = String(this.firstTimestamp);
      this.timeline.max = String(this.endTimestamp);
      this.timeline.value = String(this.firstTimestamp);
      this.currentTime.textContent = formatTime(this.firstTimestamp);
      this.duration.textContent = formatTime(this.endTimestamp);
      this.loaded = true;
      await this.startVideoIterator();
      this.loading.hidden = true;
    } catch (error) {
      if (openingId !== this.asyncId) return;
      console.error(error);
      this.error.textContent = error instanceof Error ? error.message : String(error);
      this.error.hidden = false;
      this.loading.hidden = true;
    }
  }

  getTime() {
    if (this.playing) {
      return this.audioContext.currentTime - this.audioContextStartTime + this.playbackTimeAtStart;
    }
    return this.playbackTimeAtStart;
  }

  async startVideoIterator() {
    if (!this.videoSink) return;
    const id = ++this.asyncId;
    await this.videoIterator?.return();
    if (id !== this.asyncId) return;
    this.videoIterator = this.videoSink.canvases(this.getTime());
    const first = (await this.videoIterator.next()).value ?? null;
    this.nextFrame = (await this.videoIterator.next()).value ?? null;
    if (id !== this.asyncId) return;
    if (first) this.draw(first.canvas);
  }

  draw(source) {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(source, 0, 0);
  }

  render() {
    if (this.loaded) {
      const now = this.getTime();
      if (now >= this.endTimestamp && this.playing) {
        this.pause();
        this.playbackTimeAtStart = this.endTimestamp;
      }
      if (this.nextFrame && this.nextFrame.timestamp <= now) {
        this.draw(this.nextFrame.canvas);
        this.nextFrame = null;
        void this.updateNextFrame();
      }
      if (!this.dragging) {
        this.timeline.value = String(Math.min(now, this.endTimestamp));
        this.currentTime.textContent = formatTime(now);
      }
    }
    requestAnimationFrame(() => this.render());
  }

  async updateNextFrame() {
    const id = this.asyncId;
    while (this.videoIterator) {
      const frame = (await this.videoIterator.next()).value ?? null;
      if (!frame || id !== this.asyncId) return;
      if (frame.timestamp <= this.getTime()) this.draw(frame.canvas);
      else {
        this.nextFrame = frame;
        return;
      }
    }
  }

  async runAudioIterator(id) {
    if (!this.audioIterator) return;
    for await (const { buffer, timestamp } of this.audioIterator) {
      if (id !== this.asyncId || !this.playing) return;
      const node = this.audioContext.createBufferSource();
      node.buffer = buffer;
      node.connect(this.gainNode);
      let start = this.audioContextStartTime + timestamp - this.playbackTimeAtStart;
      start = Math.round(this.audioContext.sampleRate * start) / this.audioContext.sampleRate;
      if (start >= this.audioContext.currentTime) node.start(start);
      else node.start(this.audioContext.currentTime, this.audioContext.currentTime - start);
      this.queuedAudio.add(node);
      node.onended = () => this.queuedAudio.delete(node);
      while (id === this.asyncId && timestamp - this.getTime() >= 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
  }

  async play() {
    if (!this.loaded || this.playing) return;
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
    if (this.getTime() >= this.endTimestamp) {
      this.playbackTimeAtStart = this.firstTimestamp;
      await this.startVideoIterator();
    }
    this.audioContextStartTime = this.audioContext.currentTime;
    this.playing = true;
    if (this.audioSink) {
      await this.audioIterator?.return();
      const id = this.asyncId;
      this.audioIterator = this.audioSink.buffers(this.getTime());
      void this.runAudioIterator(id);
    }
    this.playButton.textContent = '❚❚';
  }

  pause() {
    if (!this.playing) return;
    this.playbackTimeAtStart = this.getTime();
    this.playing = false;
    void this.audioIterator?.return();
    this.audioIterator = null;
    for (const node of this.queuedAudio) node.stop();
    this.queuedAudio.clear();
    this.playButton.textContent = '▶';
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  async seek(seconds) {
    if (!this.loaded) return;
    const resume = this.playing;
    this.pause();
    this.playbackTimeAtStart = Math.max(this.firstTimestamp, Math.min(seconds, this.endTimestamp));
    await this.startVideoIterator();
    if (resume && this.playbackTimeAtStart < this.endTimestamp) await this.play();
  }

  updateVolume() {
    if (this.gainNode) this.gainNode.gain.value = this.volumeValue ** 2;
    this.mute.textContent = this.volumeValue === 0 ? 'muted' : 'vol';
  }

  async dispose() {
    this.pause();
    this.loaded = false;
    this.asyncId++;
    await this.videoIterator?.return();
    await this.audioIterator?.return();
    this.videoIterator = null;
    this.audioIterator = null;
    this.videoSink = null;
    this.audioSink = null;
    this.nextFrame = null;
    this.input?.dispose();
    this.input = null;
    if (this.audioContext) await this.audioContext.close();
    this.audioContext = null;
  }
}
