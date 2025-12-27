<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { open, save } from '@tauri-apps/plugin-dialog';
  import { onMount } from 'svelte';
  import { createLogger } from './lib/logger';

  const log = createLogger('App');
  const importLog = createLogger('Import');
  const exportLog = createLogger('Export');

  interface AudioInfo {
    duration: number;
    sample_rate: number;
    channels: number;
  }

  interface SpectrogramData {
    data: number[][];
    times: number[];
    max_freq: number;
  }

  interface ForensicData {
    enf_present: boolean;
    enf_strength_db: number;
    grid_freq: number;
    splice_times: number[];
    snr_db: number;
    dynamic_range_db: number;
    has_clipping: boolean;
    clipped_count: number;
  }

  interface AudioSamples {
    samples: number[];
    sample_rate: number;
    channels: number;
  }

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;

  // === PERFORMANCE OPTIMIZATION: Cached rendering objects ===
  let cachedSpectrogramBitmap: ImageBitmap | null = null;
  let cachedSpectrogramCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  let cachedSpectrogramCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  let spectrogramNeedsRedraw = true;
  let lastDynamicsLow = -100;
  let lastDynamicsHigh = 0;

  // Pre-computed color lookup tables (256 entries each)
  let viridisLUT: Uint8Array | null = null;  // 256 * 3 = 768 bytes (RGB)
  let frequencyLUT: Uint8Array | null = null;
  let dimmedLUT: Uint8Array | null = null;   // Pre-computed dimmed colors

  // Reusable typed arrays to avoid GC pressure
  let meterDataArray: Uint8Array | null = null;

  // Throttle resize
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

  let audioInfo: AudioInfo | null = null;
  let spectrogramData: SpectrogramData | null = null;
  let forensicData: ForensicData | null = null;
  let filePath = '';
  let loading = false;
  let loadingStage = '';
  let error = '';
  let maxFreq = 8000;

  // Audio playback state
  let audioContext: AudioContext | null = null;
  let audioBuffer: AudioBuffer | null = null;
  let sourceNode: AudioBufferSourceNode | null = null;
  let highPassFilter: BiquadFilterNode | null = null;
  let lowPassFilter: BiquadFilterNode | null = null;
  let volumeNode: GainNode | null = null;
  let amplifyNode: GainNode | null = null;
  let analyserNode: AnalyserNode | null = null;

  // Dynamics processing nodes
  let compressorNode: DynamicsCompressorNode | null = null;
  let limiterNode: DynamicsCompressorNode | null = null;
  let saturatorNode: WaveShaperNode | null = null;

  // Multiband compression nodes
  let lowBandFilter: BiquadFilterNode | null = null;
  let midBandFilter: BiquadFilterNode | null = null;
  let highBandFilter: BiquadFilterNode | null = null;
  let lowBandCompressor: DynamicsCompressorNode | null = null;
  let midBandCompressor: DynamicsCompressorNode | null = null;
  let highBandCompressor: DynamicsCompressorNode | null = null;
  let multibandMerger: GainNode | null = null;

  let isPlaying = false;

  // Level meter state
  let meterCanvas: HTMLCanvasElement;
  let meterCtx: CanvasRenderingContext2D | null = null;
  const numBands = 32; // Number of EQ bands
  let peakLevels: number[] = new Array(numBands).fill(0); // Peak hold per band
  let peakDecay: number[] = new Array(numBands).fill(0); // Peak decay timers

  // Band solo state
  let soloedBand: number | null = null;
  let soloBandpassFilter: BiquadFilterNode | null = null;
  let soloBandpassFilter2: BiquadFilterNode | null = null; // Second filter for steeper rolloff

  // Dynamics range filter (visual + audio)
  let dynamicsLow = -100; // dB - lower threshold
  let dynamicsHigh = 0; // dB - upper threshold
  let dynamicsGateNode: WaveShaperNode | null = null;

  // Volume and amplify controls (1.0 = 100%)
  let volume = 1.0; // 0 to 1
  let amplify = 1.0; // 1 to 5 (100% to 500%)

  // Effects controls
  let showEffects = false;

  // Compressor settings
  let compressorEnabled = false;
  let compThreshold = -24; // dB
  let compRatio = 4; // x:1
  let compAttack = 0.003; // seconds
  let compRelease = 0.25; // seconds
  let compKnee = 10; // dB

  // Limiter settings
  let limiterEnabled = false;
  let limiterThreshold = -3; // dB
  let limiterRelease = 0.1; // seconds

  // Multiband compression settings
  let multibandEnabled = false;
  let mbLowGain = 1.0;
  let mbMidGain = 1.0;
  let mbHighGain = 1.0;
  let mbLowThreshold = -20;
  let mbMidThreshold = -18;
  let mbHighThreshold = -16;

  // Saturation settings
  let saturationEnabled = false;
  let saturationAmount = 0.3; // 0 to 1

  // Normalization
  let normalizeEnabled = false;
  let normalizeTarget = -1; // dB
  let normalizeGain = 1.0; // Calculated gain
  let currentTime = 0;
  let startTime = 0;
  let pausedAt = 0;
  let animationId: number | null = null;
  let showInfo = false;
  let showMeter = true; // Show EQ meter by default
  let isFullscreen = false;

  // Selection state for export
  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  let isSelecting = false;
  let exportLoading = false;

  // Filter controls - frequencies in Hz
  let highPassFreq = 100; // Default to 100Hz (visible at bottom)
  let lowPassFreq = 8000; // Default to maxFreq
  let draggingFilter: 'highpass' | 'lowpass' | null = null;
  let filterHover: 'highpass' | 'lowpass' | null = null;

  // Keep lowPassFreq in sync with maxFreq
  $: if (lowPassFreq > maxFreq) lowPassFreq = maxFreq;

  // Update filter frequencies reactively
  $: if (highPassFilter) {
    highPassFilter.frequency.setValueAtTime(highPassFreq > 0 ? highPassFreq : 0, audioContext?.currentTime || 0);
  }
  $: if (lowPassFilter) {
    lowPassFilter.frequency.setValueAtTime(lowPassFreq, audioContext?.currentTime || 0);
  }

  // Update volume and amplify reactively
  $: if (volumeNode) {
    volumeNode.gain.setValueAtTime(volume, audioContext?.currentTime || 0);
  }
  $: if (amplifyNode) {
    amplifyNode.gain.setValueAtTime(amplify, audioContext?.currentTime || 0);
  }

  // Update compressor settings reactively
  $: if (compressorNode && audioContext) {
    compressorNode.threshold.setValueAtTime(compThreshold, audioContext.currentTime);
    compressorNode.ratio.setValueAtTime(compRatio, audioContext.currentTime);
    compressorNode.attack.setValueAtTime(compAttack, audioContext.currentTime);
    compressorNode.release.setValueAtTime(compRelease, audioContext.currentTime);
    compressorNode.knee.setValueAtTime(compKnee, audioContext.currentTime);
  }

  // Update limiter settings reactively
  $: if (limiterNode && audioContext) {
    limiterNode.threshold.setValueAtTime(limiterThreshold, audioContext.currentTime);
    limiterNode.release.setValueAtTime(limiterRelease, audioContext.currentTime);
  }

  // Update multiband gains reactively
  $: if (lowBandCompressor && audioContext) {
    lowBandCompressor.threshold.setValueAtTime(mbLowThreshold, audioContext.currentTime);
  }
  $: if (midBandCompressor && audioContext) {
    midBandCompressor.threshold.setValueAtTime(mbMidThreshold, audioContext.currentTime);
  }
  $: if (highBandCompressor && audioContext) {
    highBandCompressor.threshold.setValueAtTime(mbHighThreshold, audioContext.currentTime);
  }

  // Update saturation curve reactively
  $: if (saturatorNode && saturationAmount !== undefined) {
    saturatorNode.curve = makeSaturationCurve(saturationAmount);
  }

  // Update dynamics gate curve reactively
  $: if (dynamicsGateNode && spectrogramData) {
    dynamicsGateNode.curve = makeDynamicsGateCurve(dynamicsLow, dynamicsHigh, cachedMinDb, cachedMaxDb);
  }

  // Invalidate spectrogram cache when dynamics range changes
  $: if (spectrogramData && (dynamicsLow !== lastDynamicsLow || dynamicsHigh !== lastDynamicsHigh)) {
    lastDynamicsLow = dynamicsLow;
    lastDynamicsHigh = dynamicsHigh;
    spectrogramNeedsRedraw = true;
    cachedSpectrogramBitmap?.close();
    cachedSpectrogramBitmap = null;
    drawSpectrogram();
  }

  // Cached spectrogram data for redraw
  let cachedMinDb = 0;
  let cachedMaxDb = 0;

  onMount(() => {
    // Global error handler to catch uncaught errors
    window.onerror = (message, source, lineno, colno, error) => {
      log.error('Uncaught error', { message, source, lineno, colno, error: String(error) });
      return false;
    };
    window.onunhandledrejection = (event) => {
      log.error('Unhandled rejection', { reason: String(event.reason) });
    };

    // Optimized canvas context - disable alpha for better performance
    ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,  // Reduces latency on some systems
    }) as CanvasRenderingContext2D;

    // Initialize color lookup tables for fast rendering
    initColorLUTs();

    resizeCanvas();
    window.addEventListener('resize', throttledResize);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      window.removeEventListener('resize', throttledResize);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (animationId) cancelAnimationFrame(animationId);
      if (audioContext) audioContext.close();
      if (resizeTimeout) clearTimeout(resizeTimeout);
      // Clean up cached resources
      cachedSpectrogramBitmap?.close();
      cachedSpectrogramBitmap = null;
    };
  });

  // === PERFORMANCE: Pre-compute color lookup tables ===
  function initColorLUTs() {
    // Viridis colormap LUT (256 entries × 3 channels)
    viridisLUT = new Uint8Array(256 * 3);
    dimmedLUT = new Uint8Array(256 * 3);
    frequencyLUT = new Uint8Array(256 * 3);

    for (let i = 0; i < 256; i++) {
      const t = i / 255;

      // Viridis colormap
      const vr = Math.floor(Math.max(0, Math.min(255,
        68.0 + t * (-71.3 + t * (338.3 + t * (-467.5 + t * 387.5))))));
      const vg = Math.floor(Math.max(0, Math.min(255,
        1.0 + t * (169.0 + t * (-75.0 + t * (134.0 + t * 27.0))))));
      const vb = Math.floor(Math.max(0, Math.min(255,
        84.0 + t * (145.0 + t * (-520.0 + t * (722.0 + t * -395.0))))));

      viridisLUT[i * 3] = vr;
      viridisLUT[i * 3 + 1] = vg;
      viridisLUT[i * 3 + 2] = vb;

      // Pre-compute dimmed version (for dynamics filtering)
      const gray = Math.floor((vr + vg + vb) / 3 * 0.15);
      dimmedLUT[i * 3] = gray;
      dimmedLUT[i * 3 + 1] = gray;
      dimmedLUT[i * 3 + 2] = Math.floor(gray * 1.1);

      // Frequency bar gradient (Cyan to Magenta)
      frequencyLUT[i * 3] = Math.floor(255 * t);
      frequencyLUT[i * 3 + 1] = Math.floor(255 * (1 - t));
      frequencyLUT[i * 3 + 2] = 255;
    }
  }

  // Throttled resize to prevent excessive redraws
  function throttledResize() {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(resizeCanvas, 100);
  }

  function resizeCanvas() {
    if (canvas) {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      // Invalidate spectrogram cache on resize
      spectrogramNeedsRedraw = true;
      cachedSpectrogramBitmap?.close();
      cachedSpectrogramBitmap = null;
      if (spectrogramData) {
        drawSpectrogram();
      }
    }
  }

  // Create soft saturation curve for WaveShaperNode
  function makeSaturationCurve(amount: number): Float32Array {
    const samples = 44100;
    const curve = new Float32Array(samples);
    const k = amount * 50; // Scale amount

    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      // Soft clipping using tanh-like curve
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  // Create dynamics gate curve that passes only samples within the dB range
  function makeDynamicsGateCurve(lowDb: number, highDb: number, minDb: number, maxDb: number): Float32Array {
    const samples = 8192;
    const curve = new Float32Array(samples);

    // Convert dB thresholds to linear amplitude (0-1 range)
    // The spectrogram's dB values are relative, so we map them to amplitude
    const dbRange = maxDb - minDb;
    if (dbRange === 0) {
      // No range, pass through
      for (let i = 0; i < samples; i++) {
        curve[i] = (i * 2) / samples - 1;
      }
      return curve;
    }

    // Normalize thresholds to 0-1 based on the actual dB range
    const lowNorm = Math.max(0, Math.min(1, (lowDb - minDb) / dbRange));
    const highNorm = Math.max(0, Math.min(1, (highDb - minDb) / dbRange));

    // Convert normalized dB to linear amplitude thresholds
    // Using approximation: amplitude = 10^(dB/20) relative scale
    const lowAmp = Math.pow(10, (lowNorm - 1) * 3); // Scale factor
    const highAmp = Math.pow(10, (highNorm - 1) * 3);

    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1; // -1 to +1
      const absX = Math.abs(x);

      // Check if amplitude is within our dynamics range
      if (absX < lowAmp) {
        // Below low threshold - attenuate significantly
        curve[i] = x * 0.05; // Heavy attenuation for sounds below range
      } else if (absX > highAmp) {
        // Above high threshold - soft limit with attenuation
        const excess = absX - highAmp;
        const limited = highAmp + excess * 0.1; // Compress excess
        curve[i] = x > 0 ? limited : -limited;
      } else {
        // Within range - pass through
        curve[i] = x;
      }
    }
    return curve;
  }

  // Calculate normalization gain from audio samples
  function calculateNormalizationGain(): number {
    const samples = audioBuffer?.getChannelData(0);
    if (!samples) return 1.0;

    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > peak) peak = abs;
    }

    if (peak === 0) return 1.0;

    // Target level in linear scale
    const targetLinear = Math.pow(10, normalizeTarget / 20);
    const gain = targetLinear / peak;

    return Math.min(gain, 10); // Cap at 10x to prevent extreme gain
  }

  // Apply normalization when enabled
  function applyNormalization() {
    if (normalizeEnabled && audioBuffer) {
      normalizeGain = calculateNormalizationGain();
    } else {
      normalizeGain = 1.0;
    }
  }

  async function loadAudio() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }]
      });

      if (selected) {
        filePath = selected as string;
        loading = true;
        loadingStage = 'Opening file...';
        error = '';
        importLog.info('Starting import', { file: filePath });

        // Stop any playing audio
        stopAudio();

        loadingStage = 'Decoding audio...';
        const startDecode = performance.now();
        audioInfo = await invoke<AudioInfo>('load_audio', { path: filePath });
        importLog.debug('Audio decoded', {
          durationSec: ((performance.now() - startDecode) / 1000).toFixed(1),
          sampleRate: audioInfo.sample_rate,
          channels: audioInfo.channels,
          duration: audioInfo.duration.toFixed(2)
        });

        loadingStage = 'Computing spectrogram...';

        // Reset caches before loading new spectrogram
        cachedMinDb = 0;
        cachedMaxDb = 0;
        spectrogramNeedsRedraw = true;
        cachedSpectrogramBitmap?.close();
        cachedSpectrogramBitmap = null;

        const startSpec = performance.now();
        spectrogramData = await invoke<SpectrogramData>('compute_spectrogram', { maxFreq });
        importLog.debug('Spectrogram computed', {
          durationSec: ((performance.now() - startSpec) / 1000).toFixed(1)
        });

        loadingStage = 'Running forensic analysis...';
        const startForensic = performance.now();
        forensicData = await invoke<ForensicData>('analyze_forensics');
        importLog.debug('Forensic analysis complete', {
          durationSec: ((performance.now() - startForensic) / 1000).toFixed(1)
        });

        loadingStage = 'Preparing playback...';
        const samples = await invoke<AudioSamples>('get_audio_samples');
        importLog.debug('Samples loaded', { count: samples.samples.length });

        try {
          await createAudioBuffer(samples);
          importLog.debug('Audio buffer created');
        } catch (bufferErr) {
          importLog.error('Audio buffer creation failed', { error: String(bufferErr) });
          throw bufferErr;
        }

        try {
          drawSpectrogram();
          importLog.debug('Spectrogram rendered');
        } catch (drawErr) {
          importLog.error('Spectrogram drawing failed', { error: String(drawErr) });
          throw drawErr;
        }

        // Initialize dynamics range to full range of the audio
        dynamicsLow = cachedMinDb;
        dynamicsHigh = cachedMaxDb;
        loading = false;
        importLog.info('Import complete');
      }
    } catch (e) {
      error = String(e);
      loading = false;
    }
  }

  async function exportAudio() {
    if (!audioInfo || selectionStart === null || selectionEnd === null) {
      error = 'Please select a time range to export (Shift+click and drag)';
      return;
    }

    const startTime = Math.min(selectionStart, selectionEnd);
    const endTime = Math.max(selectionStart, selectionEnd);

    if (endTime - startTime < 0.01) {
      error = 'Selection too short to export';
      return;
    }

    try {
      const defaultName = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'export';
      const outputPath = await save({
        filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
        defaultPath: `${defaultName}_selection.wav`
      });

      if (outputPath) {
        exportLoading = true;
        error = '';
        exportLog.info('Exporting selection', {
          startTime: startTime.toFixed(3),
          endTime: endTime.toFixed(3),
          outputPath
        });

        await invoke('export_audio', {
          outputPath,
          startTime,
          endTime
        });

        exportLog.info('Export complete');
        exportLoading = false;
      }
    } catch (e) {
      error = String(e);
      exportLoading = false;
    }
  }

  async function createAudioBuffer(samples: AudioSamples) {
    if (!audioContext) {
      audioContext = new AudioContext();
    }

    // Create filter nodes
    highPassFilter = audioContext.createBiquadFilter();
    highPassFilter.type = 'highpass';
    highPassFilter.frequency.value = highPassFreq > 0 ? highPassFreq : 0;
    highPassFilter.Q.value = 0.707; // Butterworth response

    lowPassFilter = audioContext.createBiquadFilter();
    lowPassFilter.type = 'lowpass';
    lowPassFilter.frequency.value = lowPassFreq;
    lowPassFilter.Q.value = 0.707;

    // Create gain nodes for volume and amplify
    volumeNode = audioContext.createGain();
    volumeNode.gain.value = volume;

    amplifyNode = audioContext.createGain();
    amplifyNode.gain.value = amplify;

    // Create analyser node for level metering
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.8;

    // Create compressor node
    compressorNode = audioContext.createDynamicsCompressor();
    compressorNode.threshold.value = compThreshold;
    compressorNode.ratio.value = compRatio;
    compressorNode.attack.value = compAttack;
    compressorNode.release.value = compRelease;
    compressorNode.knee.value = compKnee;

    // Create limiter node (compressor with extreme settings)
    limiterNode = audioContext.createDynamicsCompressor();
    limiterNode.threshold.value = limiterThreshold;
    limiterNode.ratio.value = 20; // High ratio for limiting
    limiterNode.attack.value = 0.001; // Very fast attack
    limiterNode.release.value = limiterRelease;
    limiterNode.knee.value = 0; // Hard knee for limiting

    // Create saturation node
    saturatorNode = audioContext.createWaveShaper();
    saturatorNode.curve = makeSaturationCurve(saturationAmount);
    saturatorNode.oversample = '2x';

    // Create dynamics range gate node
    dynamicsGateNode = audioContext.createWaveShaper();
    dynamicsGateNode.curve = makeDynamicsGateCurve(dynamicsLow, dynamicsHigh, cachedMinDb, cachedMaxDb);
    dynamicsGateNode.oversample = '2x';

    // Create multiband compression nodes
    // Low band: < 200Hz
    lowBandFilter = audioContext.createBiquadFilter();
    lowBandFilter.type = 'lowpass';
    lowBandFilter.frequency.value = 200;
    lowBandFilter.Q.value = 0.5;

    lowBandCompressor = audioContext.createDynamicsCompressor();
    lowBandCompressor.threshold.value = mbLowThreshold;
    lowBandCompressor.ratio.value = 4;
    lowBandCompressor.attack.value = 0.01;
    lowBandCompressor.release.value = 0.2;

    // Mid band: 200Hz - 2kHz
    midBandFilter = audioContext.createBiquadFilter();
    midBandFilter.type = 'bandpass';
    midBandFilter.frequency.value = 632; // Geometric mean of 200 and 2000
    midBandFilter.Q.value = 0.5;

    midBandCompressor = audioContext.createDynamicsCompressor();
    midBandCompressor.threshold.value = mbMidThreshold;
    midBandCompressor.ratio.value = 3;
    midBandCompressor.attack.value = 0.005;
    midBandCompressor.release.value = 0.15;

    // High band: > 2kHz
    highBandFilter = audioContext.createBiquadFilter();
    highBandFilter.type = 'highpass';
    highBandFilter.frequency.value = 2000;
    highBandFilter.Q.value = 0.5;

    highBandCompressor = audioContext.createDynamicsCompressor();
    highBandCompressor.threshold.value = mbHighThreshold;
    highBandCompressor.ratio.value = 3;
    highBandCompressor.attack.value = 0.002;
    highBandCompressor.release.value = 0.1;

    // Merger for multiband output
    multibandMerger = audioContext.createGain();
    multibandMerger.gain.value = 1.0;

    const { samples: data, sample_rate, channels } = samples;
    const numSamples = Math.floor(data.length / channels);

    audioBuffer = audioContext.createBuffer(channels, numSamples, sample_rate);

    for (let ch = 0; ch < channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < numSamples; i++) {
        channelData[i] = data[i * channels + ch];
      }
    }
  }

  function playAudio() {
    if (!audioContext || !audioBuffer || !highPassFilter || !lowPassFilter || !volumeNode || !amplifyNode || !analyserNode) return;

    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    // Apply normalization if enabled
    applyNormalization();

    // Disconnect all nodes
    try {
      highPassFilter.disconnect();
      lowPassFilter.disconnect();
      volumeNode.disconnect();
      amplifyNode.disconnect();
      analyserNode.disconnect();
      compressorNode?.disconnect();
      limiterNode?.disconnect();
      saturatorNode?.disconnect();
      dynamicsGateNode?.disconnect();
      lowBandFilter?.disconnect();
      midBandFilter?.disconnect();
      highBandFilter?.disconnect();
      lowBandCompressor?.disconnect();
      midBandCompressor?.disconnect();
      highBandCompressor?.disconnect();
      multibandMerger?.disconnect();
    } catch (e) {
      // Ignore if not connected
    }

    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;

    // Build audio chain dynamically based on enabled effects
    // Chain: source -> HP -> LP -> [normalize] -> [multiband/compress] -> [saturate] -> [limit] -> amplify -> analyser -> volume -> dest

    let currentNode: AudioNode = sourceNode;

    // Filters first
    currentNode.connect(highPassFilter);
    currentNode = highPassFilter;
    currentNode.connect(lowPassFilter);
    currentNode = lowPassFilter;

    // Dynamics range gate (isolates sounds within dB range)
    if (dynamicsGateNode) {
      // Update the curve with current cached dB range
      dynamicsGateNode.curve = makeDynamicsGateCurve(dynamicsLow, dynamicsHigh, cachedMinDb, cachedMaxDb);
      currentNode.connect(dynamicsGateNode);
      currentNode = dynamicsGateNode;
    }

    // Normalization (applied via amplify gain adjustment)
    if (normalizeEnabled) {
      amplifyNode.gain.setValueAtTime(amplify * normalizeGain, audioContext.currentTime);
    } else {
      amplifyNode.gain.setValueAtTime(amplify, audioContext.currentTime);
    }

    // Multiband compression (splits signal into 3 bands, compresses, recombines)
    if (multibandEnabled && lowBandFilter && midBandFilter && highBandFilter &&
        lowBandCompressor && midBandCompressor && highBandCompressor && multibandMerger) {
      // Split into 3 bands
      currentNode.connect(lowBandFilter);
      currentNode.connect(midBandFilter);
      currentNode.connect(highBandFilter);

      // Compress each band
      lowBandFilter.connect(lowBandCompressor);
      midBandFilter.connect(midBandCompressor);
      highBandFilter.connect(highBandCompressor);

      // Merge back together
      lowBandCompressor.connect(multibandMerger);
      midBandCompressor.connect(multibandMerger);
      highBandCompressor.connect(multibandMerger);

      currentNode = multibandMerger;
    }

    // Single-band compressor
    if (compressorEnabled && compressorNode) {
      currentNode.connect(compressorNode);
      currentNode = compressorNode;
    }

    // Saturation
    if (saturationEnabled && saturatorNode) {
      currentNode.connect(saturatorNode);
      currentNode = saturatorNode;
    }

    // Limiter (should be last in dynamics chain)
    if (limiterEnabled && limiterNode) {
      currentNode.connect(limiterNode);
      currentNode = limiterNode;
    }

    // Final chain: amplify -> analyser -> volume -> destination
    currentNode.connect(amplifyNode);
    amplifyNode.connect(analyserNode);
    analyserNode.connect(volumeNode);
    volumeNode.connect(audioContext.destination);

    sourceNode.onended = () => {
      if (isPlaying) {
        isPlaying = false;
        currentTime = 0;
        pausedAt = 0;
        drawSpectrogram();
      }
    };

    startTime = audioContext.currentTime - pausedAt;
    sourceNode.start(0, pausedAt);
    isPlaying = true;
    updatePlayhead();
  }

  function pauseAudio() {
    if (!sourceNode || !audioContext) return;

    pausedAt = audioContext.currentTime - startTime;
    sourceNode.stop();
    sourceNode = null;
    isPlaying = false;
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  function stopAudio() {
    if (sourceNode) {
      sourceNode.stop();
      sourceNode = null;
    }
    isPlaying = false;
    currentTime = 0;
    pausedAt = 0;
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (spectrogramData) drawSpectrogram();
    clearLevelMeter();
  }

  function clearLevelMeter() {
    if (!meterCtx || !meterCanvas) return;
    meterCtx.fillStyle = '#1a1a2e';
    meterCtx.fillRect(0, 0, meterCanvas.width, meterCanvas.height);
    peakLevels = new Array(numBands).fill(0);
    peakDecay = new Array(numBands).fill(0);
  }

  function togglePlayPause() {
    if (isPlaying) {
      pauseAudio();
    } else {
      playAudio();
    }
  }

  function updatePlayhead() {
    if (!isPlaying || !audioContext || !audioInfo) return;

    currentTime = audioContext.currentTime - startTime;

    if (currentTime >= audioInfo.duration) {
      stopAudio();
      return;
    }

    drawSpectrogram();
    drawLevelMeter();
    animationId = requestAnimationFrame(updatePlayhead);
  }

  function drawLevelMeter() {
    if (!meterCtx || !meterCanvas || !analyserNode) return;

    const width = meterCanvas.width;
    const height = meterCanvas.height;
    const bandCount = 16; // Number of EQ bands
    const bandWidth = Math.floor(width / bandCount) - 2;
    const bandGap = 2;

    // Get frequency data - OPTIMIZED: reuse typed array
    const bufferLength = analyserNode.frequencyBinCount;
    if (!meterDataArray || meterDataArray.length !== bufferLength) {
      meterDataArray = new Uint8Array(bufferLength);
    }
    analyserNode.getByteFrequencyData(meterDataArray);
    const dataArray = meterDataArray;

    // Clear canvas
    meterCtx.fillStyle = '#1a1a2e';
    meterCtx.fillRect(0, 0, width, height);

    // Calculate band values (logarithmic frequency distribution)
    const bands: number[] = [];
    for (let i = 0; i < bandCount; i++) {
      // Logarithmic frequency mapping
      const lowFreq = 20 * Math.pow(10, (i / bandCount) * 3);
      const highFreq = 20 * Math.pow(10, ((i + 1) / bandCount) * 3);
      const sampleRate = audioContext?.sampleRate || 44100;
      const lowBin = Math.floor((lowFreq / sampleRate) * bufferLength * 2);
      const highBin = Math.min(Math.floor((highFreq / sampleRate) * bufferLength * 2), bufferLength - 1);

      let sum = 0;
      let count = 0;
      for (let j = lowBin; j <= highBin; j++) {
        sum += dataArray[j];
        count++;
      }
      bands.push(count > 0 ? sum / count / 255 : 0);
    }

    // Draw EQ bands
    for (let i = 0; i < bandCount; i++) {
      const x = i * (bandWidth + bandGap) + bandGap;
      const level = bands[i];
      const barHeight = level * (height - 14);

      // Gradient from green to yellow to red
      const gradient = meterCtx.createLinearGradient(x, height, x, height - barHeight);
      if (level > 0.85) {
        gradient.addColorStop(0, '#22c55e');
        gradient.addColorStop(0.6, '#eab308');
        gradient.addColorStop(1, '#ef4444');
      } else if (level > 0.5) {
        gradient.addColorStop(0, '#22c55e');
        gradient.addColorStop(1, '#eab308');
      } else {
        gradient.addColorStop(0, '#22c55e');
        gradient.addColorStop(1, '#4ade80');
      }

      meterCtx.fillStyle = gradient;
      meterCtx.fillRect(x, height - barHeight - 12, bandWidth, barHeight);

      // Update peak for this band
      if (level > peakLevels[i]) {
        peakLevels[i] = level;
        peakDecay[i] = 30; // Hold for 30 frames
      }

      // Draw peak indicator
      const peakY = height - (peakLevels[i] * (height - 14)) - 12;
      meterCtx.fillStyle = peakLevels[i] > 0.85 ? '#ef4444' : peakLevels[i] > 0.5 ? '#eab308' : '#4ade80';
      meterCtx.fillRect(x, peakY - 2, bandWidth, 2);
    }

    // Decay peaks
    for (let i = 0; i < bandCount; i++) {
      if (peakDecay[i] > 0) {
        peakDecay[i]--;
      } else {
        peakLevels[i] = Math.max(0, peakLevels[i] - 0.02);
      }
    }

    // Draw frequency labels at bottom
    meterCtx.fillStyle = '#666';
    meterCtx.font = '8px monospace';
    meterCtx.textAlign = 'center';
    const freqLabels = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
    const labelPositions = [0, 2, 4, 6, 8, 10, 12, 13, 14, 15];
    for (let i = 0; i < freqLabels.length; i++) {
      const pos = labelPositions[i];
      if (pos < bandCount) {
        const x = pos * (bandWidth + bandGap) + bandGap + bandWidth / 2;
        meterCtx.fillText(freqLabels[i], x, height - 1);
      }
    }

    // Draw dB scale on right side
    meterCtx.fillStyle = '#444';
    meterCtx.textAlign = 'right';
    meterCtx.fillText('0dB', width - 2, 10);
    meterCtx.fillText('-20', width - 2, height / 2);

    // Draw grid lines
    meterCtx.strokeStyle = '#333';
    meterCtx.lineWidth = 0.5;
    for (let db = 0; db <= 60; db += 12) {
      const y = (db / 60) * (height - 12) + 2;
      meterCtx.beginPath();
      meterCtx.moveTo(0, y);
      meterCtx.lineTo(width - 20, y);
      meterCtx.stroke();
    }
  }

  function initMeterCanvas(node: HTMLCanvasElement) {
    meterCanvas = node;
    // Optimized context for meter (no alpha, desynchronized for low latency)
    meterCtx = node.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });
    if (meterCtx) {
      node.width = node.offsetWidth;
      node.height = node.offsetHeight;
    }
    return {
      destroy() {
        meterCtx = null;
        meterDataArray = null;
      }
    };
  }

  function seekAudio(event: MouseEvent) {
    if (!audioInfo || !canvas || !spectrogramData) return;

    const rect = canvas.getBoundingClientRect();
    const legendWidth = 60;
    const freqBarHeight = 30;
    const spectrogramWidth = canvas.width - legendWidth;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Ignore clicks on frequency bar or legend
    if (x > spectrogramWidth || y < freqBarHeight) return;

    const seekTime = (x / spectrogramWidth) * audioInfo.duration;

    const wasPlaying = isPlaying;
    if (isPlaying) {
      pauseAudio();
    }

    pausedAt = Math.max(0, Math.min(seekTime, audioInfo.duration));
    currentTime = pausedAt;

    if (wasPlaying) {
      playAudio();
    } else {
      drawSpectrogram();
    }
  }

  function getFilterYPositions() {
    if (!canvas) return { highPassY: 0, lowPassY: 0 };
    const freqBarHeight = 30;
    const spectrogramHeight = canvas.height - freqBarHeight;

    // Convert frequency to Y position (lower freq = higher Y on screen)
    const highPassY = freqBarHeight + spectrogramHeight * (1 - highPassFreq / maxFreq);
    const lowPassY = freqBarHeight + spectrogramHeight * (1 - lowPassFreq / maxFreq);

    return { highPassY, lowPassY };
  }

  function yToFrequency(y: number): number {
    if (!canvas) return 0;
    const freqBarHeight = 30;
    const spectrogramHeight = canvas.height - freqBarHeight;
    const normalizedY = (y - freqBarHeight) / spectrogramHeight;
    return maxFreq * (1 - normalizedY);
  }

  function handleCanvasMouseDown(event: MouseEvent) {
    if (!spectrogramData || !canvas || !audioInfo) return;

    const rect = canvas.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const x = event.clientX - rect.left;
    const legendWidth = 60;
    const freqBarHeight = 30;
    const spectrogramWidth = canvas.width - legendWidth;

    // Ignore clicks on legend or frequency bar
    if (x > spectrogramWidth || y < freqBarHeight) return;

    const { highPassY, lowPassY } = getFilterYPositions();
    const hitThreshold = 10; // pixels

    // Check if clicking near a filter line
    if (Math.abs(y - highPassY) < hitThreshold) {
      draggingFilter = 'highpass';
      event.preventDefault();
    } else if (Math.abs(y - lowPassY) < hitThreshold) {
      draggingFilter = 'lowpass';
      event.preventDefault();
    } else if (event.shiftKey) {
      // Shift+click to start/extend selection
      const clickTime = (x / spectrogramWidth) * audioInfo.duration;
      if (selectionStart === null) {
        selectionStart = clickTime;
        selectionEnd = clickTime;
        isSelecting = true;
      } else {
        // Extend selection to clicked position
        selectionEnd = clickTime;
        isSelecting = true;
      }
      event.preventDefault();
      drawSpectrogram();
    } else {
      // Clear selection and seek
      selectionStart = null;
      selectionEnd = null;
      seekAudio(event);
    }
  }

  function handleCanvasMouseMove(event: MouseEvent) {
    if (!canvas || !spectrogramData || !audioInfo) return;

    const rect = canvas.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const x = event.clientX - rect.left;
    const legendWidth = 60;
    const spectrogramWidth = canvas.width - legendWidth;

    if (isSelecting && selectionStart !== null) {
      // Update selection end while dragging
      const dragTime = Math.max(0, Math.min(audioInfo.duration, (x / spectrogramWidth) * audioInfo.duration));
      selectionEnd = dragTime;
      drawSpectrogram();
    } else if (draggingFilter) {
      const newFreq = Math.max(0, Math.min(maxFreq, yToFrequency(y)));

      if (draggingFilter === 'highpass') {
        // High pass can't exceed low pass - 100Hz
        highPassFreq = Math.min(newFreq, lowPassFreq - 100);
        highPassFreq = Math.max(0, highPassFreq);
      } else {
        // Low pass can't go below high pass + 100Hz
        lowPassFreq = Math.max(newFreq, highPassFreq + 100);
        lowPassFreq = Math.min(maxFreq, lowPassFreq);
      }
      drawSpectrogram();
    } else {
      // Update hover state for cursor
      const { highPassY, lowPassY } = getFilterYPositions();
      const hitThreshold = 10;

      if (Math.abs(y - highPassY) < hitThreshold) {
        filterHover = 'highpass';
      } else if (Math.abs(y - lowPassY) < hitThreshold) {
        filterHover = 'lowpass';
      } else {
        filterHover = null;
      }
    }
  }

  function handleCanvasMouseUp() {
    draggingFilter = null;
    isSelecting = false;
    // Normalize selection so start < end
    if (selectionStart !== null && selectionEnd !== null && selectionStart > selectionEnd) {
      [selectionStart, selectionEnd] = [selectionEnd, selectionStart];
    }
  }

  function handleCanvasMouseLeave() {
    draggingFilter = null;
    filterHover = null;
    isSelecting = false;
  }

  function clearSelection() {
    selectionStart = null;
    selectionEnd = null;
    drawSpectrogram();
  }

  function getSelectionDuration(): number {
    if (selectionStart === null || selectionEnd === null) return 0;
    return Math.abs(selectionEnd - selectionStart);
  }

  // === OPTIMIZED SPECTROGRAM RENDERING ===
  function drawSpectrogram() {
    if (!ctx || !spectrogramData || !canvas) return;

    const { data, times } = spectrogramData;
    if (data.length === 0) return;

    const width = canvas.width;
    const height = canvas.height;
    const legendWidth = 60;
    const freqBarHeight = 30;
    const spectrogramWidth = width - legendWidth;
    const spectrogramHeight = height - freqBarHeight;

    const numFrames = data.length;
    const numBins = data[0]?.length || 0;
    if (numBins === 0) return;

    // Only recalculate min/max once per data load
    if (cachedMinDb === 0 && cachedMaxDb === 0) {
      let minDb = Infinity, maxDb = -Infinity;
      for (let i = 0; i < numFrames; i++) {
        const frame = data[i];
        for (let j = 0; j < numBins; j++) {
          const val = frame[j];
          if (val > maxDb) maxDb = val;
          if (val < minDb) minDb = val;
        }
      }
      cachedMinDb = minDb;
      cachedMaxDb = maxDb;
    }

    // === OPTIMIZATION: Cache spectrogram bitmap ===
    if (spectrogramNeedsRedraw || !cachedSpectrogramBitmap) {
      renderSpectrogramToCache(data, numFrames, numBins);
      spectrogramNeedsRedraw = false;
    }

    // Clear and draw background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, width, height);

    // Draw frequency bar at top (uses LUT)
    drawFrequencyBarOptimized(spectrogramWidth, freqBarHeight);

    // Draw cached spectrogram (fast - just a bitmap copy)
    if (cachedSpectrogramBitmap) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(cachedSpectrogramBitmap, 0, freqBarHeight, spectrogramWidth, spectrogramHeight);
    }

    // Draw dynamic elements (playhead, filters, selection) - these change every frame
    drawSelection(spectrogramWidth, freqBarHeight, spectrogramHeight);
    drawPlayhead(spectrogramWidth, freqBarHeight, height);
    drawFilterLines(spectrogramWidth, freqBarHeight, spectrogramHeight);
    drawAxes(times, numBins, spectrogramWidth, freqBarHeight, spectrogramHeight);
    drawColorLegend(spectrogramWidth, freqBarHeight, spectrogramHeight, cachedMinDb, cachedMaxDb);
  }

  // === PERFORMANCE: Render spectrogram to cached bitmap ===
  function renderSpectrogramToCache(data: number[][], numFrames: number, numBins: number) {
    if (!viridisLUT || !dimmedLUT) return;

    // Use OffscreenCanvas if available (better performance)
    const useOffscreen = typeof OffscreenCanvas !== 'undefined';

    if (!cachedSpectrogramCanvas || cachedSpectrogramCanvas.width !== numFrames || cachedSpectrogramCanvas.height !== numBins) {
      cachedSpectrogramCanvas = useOffscreen
        ? new OffscreenCanvas(numFrames, numBins)
        : document.createElement('canvas');
      if (!useOffscreen) {
        (cachedSpectrogramCanvas as HTMLCanvasElement).width = numFrames;
        (cachedSpectrogramCanvas as HTMLCanvasElement).height = numBins;
      }
      cachedSpectrogramCtx = cachedSpectrogramCanvas.getContext('2d', { alpha: false }) as any;
    }

    if (!cachedSpectrogramCtx) return;

    const imgData = cachedSpectrogramCtx.createImageData(numFrames, numBins);
    const pixels = imgData.data;
    const dbRange = cachedMaxDb - cachedMinDb;
    const dbRangeInv = dbRange > 0 ? 255 / dbRange : 0;

    // === OPTIMIZED PIXEL LOOP with LUT ===
    for (let x = 0; x < numFrames; x++) {
      const frame = data[x];
      for (let y = 0; y < numBins; y++) {
        const val = frame[y];
        const flippedY = numBins - 1 - y;
        const idx = (flippedY * numFrames + x) << 2; // Bit shift for *4

        // Fast normalization to LUT index (0-255)
        const lutIdx = Math.max(0, Math.min(255, Math.floor((val - cachedMinDb) * dbRangeInv))) * 3;

        // Check dynamics range and use appropriate LUT
        const inRange = val >= dynamicsLow && val <= dynamicsHigh;
        const lut = inRange ? viridisLUT : dimmedLUT;

        pixels[idx] = lut[lutIdx];
        pixels[idx + 1] = lut[lutIdx + 1];
        pixels[idx + 2] = lut[lutIdx + 2];
        pixels[idx + 3] = 255;
      }
    }

    cachedSpectrogramCtx.putImageData(imgData, 0, 0);

    // Create ImageBitmap for fastest possible drawing
    if (useOffscreen) {
      createImageBitmap(cachedSpectrogramCanvas as OffscreenCanvas).then(bitmap => {
        cachedSpectrogramBitmap?.close();
        cachedSpectrogramBitmap = bitmap;
      });
    } else {
      createImageBitmap(cachedSpectrogramCanvas as HTMLCanvasElement).then(bitmap => {
        cachedSpectrogramBitmap?.close();
        cachedSpectrogramBitmap = bitmap;
      });
    }
  }

  // === Draw selection overlay ===
  function drawSelection(spectrogramWidth: number, freqBarHeight: number, spectrogramHeight: number) {
    if (!ctx || !audioInfo || selectionStart === null || selectionEnd === null) return;

    const startX = (Math.min(selectionStart, selectionEnd) / audioInfo.duration) * spectrogramWidth;
    const endX = (Math.max(selectionStart, selectionEnd) / audioInfo.duration) * spectrogramWidth;
    const selectionWidth = endX - startX;

    if (selectionWidth < 1) return;

    // Draw selection highlight
    ctx.fillStyle = 'rgba(0, 200, 255, 0.25)';
    ctx.fillRect(startX, freqBarHeight, selectionWidth, spectrogramHeight);

    // Draw selection borders
    ctx.strokeStyle = '#00c8ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(startX, freqBarHeight);
    ctx.lineTo(startX, freqBarHeight + spectrogramHeight);
    ctx.moveTo(endX, freqBarHeight);
    ctx.lineTo(endX, freqBarHeight + spectrogramHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw selection time labels
    const selStart = Math.min(selectionStart, selectionEnd);
    const selEnd = Math.max(selectionStart, selectionEnd);
    const duration = selEnd - selStart;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(startX, freqBarHeight + 5, 50, 16);
    ctx.fillRect(endX - 50, freqBarHeight + 5, 50, 16);

    // Duration label in center
    const centerX = (startX + endX) / 2;
    ctx.fillRect(centerX - 30, freqBarHeight + spectrogramHeight / 2 - 10, 60, 20);

    ctx.fillStyle = '#00c8ff';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(formatTime(selStart), startX + 25, freqBarHeight + 17);
    ctx.fillText(formatTime(selEnd), endX - 25, freqBarHeight + 17);
    ctx.fillText(`${duration.toFixed(2)}s`, centerX, freqBarHeight + spectrogramHeight / 2 + 4);
  }

  // === OPTIMIZED: Draw playhead separately (dynamic element) ===
  function drawPlayhead(spectrogramWidth: number, freqBarHeight: number, height: number) {
    if (!ctx || !audioInfo || currentTime <= 0) return;

    const playheadX = (currentTime / audioInfo.duration) * spectrogramWidth;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, freqBarHeight);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    // Playhead time indicator
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(playheadX - 25, freqBarHeight + 5, 50, 18);
    ctx.fillStyle = '#ffffff';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(formatTime(currentTime), playheadX, freqBarHeight + 18);
  }

  // === OPTIMIZED: Frequency bar using LUT ===
  function drawFrequencyBarOptimized(width: number, height: number) {
    if (!ctx || !frequencyLUT) return;

    // Create ImageData for the gradient bar
    const barHeight = height - 10;
    const imgData = ctx.createImageData(width, barHeight);
    const pixels = imgData.data;

    for (let x = 0; x < width; x++) {
      const lutIdx = Math.floor((x / width) * 255) * 3;
      const r = frequencyLUT[lutIdx];
      const g = frequencyLUT[lutIdx + 1];
      const b = frequencyLUT[lutIdx + 2];

      for (let y = 0; y < barHeight; y++) {
        const idx = (y * width + x) << 2;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // Draw frequency labels
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';

    const freqLabels = [
      { freq: 20, label: '20Hz' },
      { freq: 100, label: '100' },
      { freq: 500, label: '500' },
      { freq: 1000, label: '1k' },
      { freq: 2000, label: '2k' },
      { freq: 5000, label: '5k' },
      { freq: 10000, label: '10k' },
      { freq: 20000, label: '20kHz' },
    ];

    const logMin = Math.log10(20);
    const logMax = Math.log10(maxFreq);
    const logRange = logMax - logMin;

    for (const { freq, label } of freqLabels) {
      if (freq <= maxFreq) {
        const x = ((Math.log10(freq) - logMin) / logRange) * width;
        ctx.fillText(label, x, height - 2);
      }
    }

    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('FREQUENCY', 5, 10);
  }

  function drawFrequencyBar(width: number, height: number) {
    if (!ctx) return;

    // Draw gradient bar
    for (let x = 0; x < width; x++) {
      const normalized = x / width;
      const color = getFrequencyColor(normalized);
      ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      ctx.fillRect(x, 0, 1, height - 10);
    }

    // Draw frequency labels
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';

    const freqLabels = [
      { freq: 20, label: '20Hz' },
      { freq: 100, label: '100' },
      { freq: 500, label: '500' },
      { freq: 1000, label: '1k' },
      { freq: 2000, label: '2k' },
      { freq: 5000, label: '5k' },
      { freq: 10000, label: '10k' },
      { freq: 20000, label: '20kHz' },
    ];

    for (const { freq, label } of freqLabels) {
      if (freq <= maxFreq) {
        // Use logarithmic scale for frequency position
        const logMin = Math.log10(20);
        const logMax = Math.log10(maxFreq);
        const logFreq = Math.log10(freq);
        const x = ((logFreq - logMin) / (logMax - logMin)) * width;
        ctx.fillText(label, x, height - 2);
      }
    }

    // Draw title
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('FREQUENCY', 5, 10);
  }

  function drawFilterLines(spectrogramWidth: number, freqBarHeight: number, spectrogramHeight: number) {
    if (!ctx) return;

    const lineWidth = 2;
    const labelPadding = 5;

    // Draw low pass filter line (cyan) - at top area
    const lowPassY = freqBarHeight + spectrogramHeight * (1 - lowPassFreq / maxFreq);
    ctx.strokeStyle = draggingFilter === 'lowpass' || filterHover === 'lowpass' ? '#00ffff' : 'rgba(0, 255, 255, 0.8)';
    ctx.lineWidth = draggingFilter === 'lowpass' || filterHover === 'lowpass' ? 3 : lineWidth;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(0, lowPassY);
    ctx.lineTo(spectrogramWidth, lowPassY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Low pass label - above the line
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    const lpLabel = `LP: ${Math.round(lowPassFreq)} Hz`;
    const lpLabelWidth = ctx.measureText(lpLabel).width + 10;
    ctx.fillRect(spectrogramWidth - lpLabelWidth - labelPadding, lowPassY - 18, lpLabelWidth, 16);
    ctx.fillStyle = '#00ffff';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(lpLabel, spectrogramWidth - labelPadding, lowPassY - 6);

    // Draw high pass filter line (magenta) - at bottom area (always visible)
    const highPassY = freqBarHeight + spectrogramHeight * (1 - highPassFreq / maxFreq);
    ctx.strokeStyle = draggingFilter === 'highpass' || filterHover === 'highpass' ? '#ff00ff' : 'rgba(255, 0, 255, 0.8)';
    ctx.lineWidth = draggingFilter === 'highpass' || filterHover === 'highpass' ? 3 : lineWidth;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(0, highPassY);
    ctx.lineTo(spectrogramWidth, highPassY);
    ctx.stroke();
    ctx.setLineDash([]);

    // High pass label - below the line
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    const hpLabel = `HP: ${Math.round(highPassFreq)} Hz`;
    const hpLabelWidth = ctx.measureText(hpLabel).width + 10;
    ctx.fillRect(spectrogramWidth - hpLabelWidth - labelPadding, highPassY + 4, hpLabelWidth, 16);
    ctx.fillStyle = '#ff00ff';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(hpLabel, spectrogramWidth - labelPadding, highPassY + 16);

    // Shade filtered regions (semi-transparent overlay)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';

    // Shade above low pass (frequencies being cut)
    if (lowPassFreq < maxFreq) {
      ctx.fillRect(0, freqBarHeight, spectrogramWidth, lowPassY - freqBarHeight);
    }

    // Shade below high pass (frequencies being cut)
    if (highPassFreq > 0) {
      ctx.fillRect(0, highPassY, spectrogramWidth, freqBarHeight + spectrogramHeight - highPassY);
    }
  }

  // Viridis colormap - perceptually uniform, colorblind-friendly
  function getSpectrogramColor(value: number): { r: number; g: number; b: number } {
    const t = Math.max(0, Math.min(1, value));

    // Viridis colormap approximation (dark purple → teal → green → yellow)
    const r = Math.floor(Math.max(0, Math.min(255,
      68.0 + t * (-71.3 + t * (338.3 + t * (-467.5 + t * 387.5))))));
    const g = Math.floor(Math.max(0, Math.min(255,
      1.0 + t * (169.0 + t * (-75.0 + t * (134.0 + t * 27.0))))));
    const b = Math.floor(Math.max(0, Math.min(255,
      84.0 + t * (145.0 + t * (-520.0 + t * (722.0 + t * -395.0))))));

    return { r, g, b };
  }

  // Cyan-Magenta gradient for frequency bar
  function getFrequencyColor(normalized: number): { r: number; g: number; b: number } {
    const t = Math.max(0, Math.min(1, normalized));
    // Cyan (#00FFFF) to Magenta (#FF00FF)
    const r = Math.floor(255 * t);
    const g = Math.floor(255 * (1 - t));
    const b = 255;
    return { r, g, b };
  }

  // Neon Rainbow gradient for dB scale
  function getNeonDbColor(normalized: number): { r: number; g: number; b: number } {
    const t = Math.max(0, Math.min(1, normalized));
    // Neon Red → Orange → Yellow → Green → Blue → Purple
    const colors = [
      { pos: 0.0, r: 255, g: 7, b: 58 },     // Neon Red
      { pos: 0.2, r: 255, g: 102, b: 0 },    // Neon Orange
      { pos: 0.4, r: 255, g: 255, b: 0 },    // Neon Yellow
      { pos: 0.6, r: 0, g: 255, b: 65 },     // Neon Green
      { pos: 0.8, r: 0, g: 184, b: 255 },    // Neon Blue
      { pos: 1.0, r: 180, g: 0, b: 255 },    // Neon Purple
    ];

    for (let i = 0; i < colors.length - 1; i++) {
      if (t >= colors[i].pos && t <= colors[i + 1].pos) {
        const localT = (t - colors[i].pos) / (colors[i + 1].pos - colors[i].pos);
        return {
          r: Math.floor(colors[i].r + (colors[i + 1].r - colors[i].r) * localT),
          g: Math.floor(colors[i].g + (colors[i + 1].g - colors[i].g) * localT),
          b: Math.floor(colors[i].b + (colors[i + 1].b - colors[i].b) * localT),
        };
      }
    }
    return colors[colors.length - 1];
  }

  function drawAxes(times: number[], numBins: number, spectrogramWidth: number, freqBarHeight: number, spectrogramHeight: number) {
    if (!ctx || !canvas) return;

    ctx.fillStyle = '#ffffff';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';

    // Time axis (bottom)
    const duration = times[times.length - 1] || 0;
    for (let i = 0; i <= 5; i++) {
      const t = (duration * i) / 5;
      const x = (spectrogramWidth * i) / 5;
      ctx.fillText(t.toFixed(1) + 's', x + 5, canvas.height - 5);
    }

    // Frequency axis (left side of spectrogram)
    for (let i = 0; i <= 4; i++) {
      const freq = (maxFreq * i) / 4;
      const y = freqBarHeight + spectrogramHeight - (spectrogramHeight * i) / 4;
      ctx.fillText((freq / 1000).toFixed(1) + 'k', 5, y - 5);
    }
  }

  function drawColorLegend(startX: number, freqBarHeight: number, spectrogramHeight: number, minDb: number, maxDb: number) {
    if (!ctx || !canvas) return;

    const barWidth = 20;
    const barHeight = spectrogramHeight - 40;
    const barX = startX + 15;
    const barY = freqBarHeight + 20;

    // Draw Neon Rainbow gradient for dB scale
    for (let y = 0; y < barHeight; y++) {
      const normalized = 1 - (y / barHeight);
      const color = getNeonDbColor(normalized);
      ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      ctx.fillRect(barX, barY + y, barWidth, 1);
    }

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barWidth, barHeight);

    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';

    // Draw dB labels
    const numLabels = 5;
    for (let i = 0; i <= numLabels; i++) {
      const normalized = i / numLabels;
      const dbValue = minDb + (maxDb - minDb) * (1 - normalized);
      const y = barY + (barHeight * normalized);
      ctx.fillText(dbValue.toFixed(0) + 'dB', barX + barWidth + 3, y + 4);
    }

    // Draw title
    ctx.save();
    ctx.translate(startX + 8, freqBarHeight + spectrogramHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.font = '11px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText('DYNAMICS', 0, 0);
    ctx.restore();
  }

  function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins}:${secs.padStart(4, '0')}`;
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        log.warn('Failed to enter fullscreen', { error: String(err) });
      });
    } else {
      document.exitFullscreen();
    }
  }

  function handleFullscreenChange() {
    isFullscreen = !!document.fullscreenElement;
    // Resize canvas after fullscreen change
    setTimeout(resizeCanvas, 100);
  }
</script>

<main class:fullscreen={isFullscreen}>
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions a11y-no-noninteractive-tabindex -->
  <div class="spectrogram-container"
       role="application"
       aria-label="Audio spectrogram visualization - drag to adjust filter frequencies"
       tabindex="0"
       on:mousedown={handleCanvasMouseDown}
       on:mousemove={handleCanvasMouseMove}
       on:mouseup={handleCanvasMouseUp}
       on:mouseleave={handleCanvasMouseLeave}
       class:dragging={draggingFilter !== null}
       class:filter-hover={filterHover !== null}>
    <canvas bind:this={canvas}></canvas>
    {#if !spectrogramData && !loading}
      <div class="placeholder">
        <p>Load an audio file to view spectrogram</p>
      </div>
    {/if}
    {#if loading}
      <div class="loading-overlay">
        <div class="spinner"></div>
        <p>{loadingStage}</p>
      </div>
    {/if}

    <!-- Dynamics Range Filter Panel -->
    {#if spectrogramData}
      <div class="dynamics-range-panel">
        <div class="dynamics-header">
          <span>DYNAMICS RANGE</span>
          <span class="dynamics-values">{dynamicsLow.toFixed(0)} to {dynamicsHigh.toFixed(0)} dB</span>
        </div>
        <div class="dynamics-slider-container">
          <div class="dynamics-scale">
            <span>{cachedMinDb.toFixed(0)}</span>
            <span>{cachedMaxDb.toFixed(0)}</span>
          </div>
          <div class="dynamics-track">
            <div
              class="dynamics-range-fill"
              style="left: {((dynamicsLow - cachedMinDb) / (cachedMaxDb - cachedMinDb)) * 100}%; right: {100 - ((dynamicsHigh - cachedMinDb) / (cachedMaxDb - cachedMinDb)) * 100}%"
            ></div>
          </div>
          <div class="dynamics-inputs">
            <div class="dynamics-input-group">
              <label for="dynamics-low">Low:</label>
              <input
                type="range"
                id="dynamics-low"
                bind:value={dynamicsLow}
                min={cachedMinDb}
                max={dynamicsHigh - 1}
                step="1"
                class="dynamics-slider low"
              />
              <input
                type="number"
                bind:value={dynamicsLow}
                min={cachedMinDb}
                max={dynamicsHigh - 1}
                step="1"
                class="dynamics-number"
              />
              <span class="dynamics-unit">dB</span>
            </div>
            <div class="dynamics-input-group">
              <label for="dynamics-high">High:</label>
              <input
                type="range"
                id="dynamics-high"
                bind:value={dynamicsHigh}
                min={dynamicsLow + 1}
                max={cachedMaxDb}
                step="1"
                class="dynamics-slider high"
              />
              <input
                type="number"
                bind:value={dynamicsHigh}
                min={dynamicsLow + 1}
                max={cachedMaxDb}
                step="1"
                class="dynamics-number"
              />
              <span class="dynamics-unit">dB</span>
            </div>
          </div>
          <button class="dynamics-reset" on:click={() => { dynamicsLow = cachedMinDb; dynamicsHigh = cachedMaxDb; }}>
            Reset
          </button>
        </div>
      </div>
    {/if}

    <!-- EQ Level Meter -->
    {#if showMeter && audioBuffer}
      <div class="level-meter-panel">
        <div class="meter-header">
          <span>EQ SPECTRUM</span>
          <button class="meter-close" on:click={() => showMeter = false}>&times;</button>
        </div>
        <canvas class="meter-canvas" use:initMeterCanvas></canvas>
      </div>
    {/if}

    <!-- Effects Panel -->
    {#if showEffects}
      <div class="effects-panel">
        <div class="effects-header">
          <span>DYNAMICS PROCESSING</span>
          <button class="effects-close" on:click={() => showEffects = false}>&times;</button>
        </div>
        <div class="effects-content">
          <!-- Normalization -->
          <div class="effect-section">
            <label class="effect-toggle">
              <input type="checkbox" bind:checked={normalizeEnabled} on:change={() => { if (isPlaying) { pauseAudio(); playAudio(); } }} />
              <span class="effect-name">Normalize</span>
            </label>
            {#if normalizeEnabled}
              <div class="effect-controls">
                <div class="control-row">
                  <span>Target:</span>
                  <input type="range" bind:value={normalizeTarget} min="-12" max="0" step="0.5" />
                  <span class="value">{normalizeTarget} dB</span>
                </div>
                <div class="control-row info">
                  <span>Gain: {normalizeGain.toFixed(2)}x ({(20 * Math.log10(normalizeGain)).toFixed(1)} dB)</span>
                </div>
              </div>
            {/if}
          </div>

          <!-- Compressor -->
          <div class="effect-section">
            <label class="effect-toggle">
              <input type="checkbox" bind:checked={compressorEnabled} on:change={() => { if (isPlaying) { pauseAudio(); playAudio(); } }} />
              <span class="effect-name">Compressor</span>
            </label>
            {#if compressorEnabled}
              <div class="effect-controls">
                <div class="control-row">
                  <span>Threshold:</span>
                  <input type="range" bind:value={compThreshold} min="-60" max="0" step="1" />
                  <span class="value">{compThreshold} dB</span>
                </div>
                <div class="control-row">
                  <span>Ratio:</span>
                  <input type="range" bind:value={compRatio} min="1" max="20" step="0.5" />
                  <span class="value">{compRatio}:1</span>
                </div>
                <div class="control-row">
                  <span>Attack:</span>
                  <input type="range" bind:value={compAttack} min="0.001" max="0.1" step="0.001" />
                  <span class="value">{(compAttack * 1000).toFixed(0)} ms</span>
                </div>
                <div class="control-row">
                  <span>Release:</span>
                  <input type="range" bind:value={compRelease} min="0.01" max="1" step="0.01" />
                  <span class="value">{(compRelease * 1000).toFixed(0)} ms</span>
                </div>
                <div class="control-row">
                  <span>Knee:</span>
                  <input type="range" bind:value={compKnee} min="0" max="40" step="1" />
                  <span class="value">{compKnee} dB</span>
                </div>
              </div>
            {/if}
          </div>

          <!-- Multiband Compression -->
          <div class="effect-section">
            <label class="effect-toggle">
              <input type="checkbox" bind:checked={multibandEnabled} on:change={() => { if (isPlaying) { pauseAudio(); playAudio(); } }} />
              <span class="effect-name">Multiband Comp</span>
            </label>
            {#if multibandEnabled}
              <div class="effect-controls">
                <div class="control-row band-low">
                  <span>Low (&lt;200Hz):</span>
                  <input type="range" bind:value={mbLowThreshold} min="-40" max="0" step="1" />
                  <span class="value">{mbLowThreshold} dB</span>
                </div>
                <div class="control-row band-mid">
                  <span>Mid (200-2k):</span>
                  <input type="range" bind:value={mbMidThreshold} min="-40" max="0" step="1" />
                  <span class="value">{mbMidThreshold} dB</span>
                </div>
                <div class="control-row band-high">
                  <span>High (&gt;2kHz):</span>
                  <input type="range" bind:value={mbHighThreshold} min="-40" max="0" step="1" />
                  <span class="value">{mbHighThreshold} dB</span>
                </div>
              </div>
            {/if}
          </div>

          <!-- Saturation -->
          <div class="effect-section">
            <label class="effect-toggle">
              <input type="checkbox" bind:checked={saturationEnabled} on:change={() => { if (isPlaying) { pauseAudio(); playAudio(); } }} />
              <span class="effect-name">Saturation</span>
            </label>
            {#if saturationEnabled}
              <div class="effect-controls">
                <div class="control-row">
                  <span>Amount:</span>
                  <input type="range" bind:value={saturationAmount} min="0" max="1" step="0.01" />
                  <span class="value">{(saturationAmount * 100).toFixed(0)}%</span>
                </div>
              </div>
            {/if}
          </div>

          <!-- Limiter -->
          <div class="effect-section">
            <label class="effect-toggle">
              <input type="checkbox" bind:checked={limiterEnabled} on:change={() => { if (isPlaying) { pauseAudio(); playAudio(); } }} />
              <span class="effect-name">Limiter</span>
            </label>
            {#if limiterEnabled}
              <div class="effect-controls">
                <div class="control-row">
                  <span>Ceiling:</span>
                  <input type="range" bind:value={limiterThreshold} min="-12" max="0" step="0.5" />
                  <span class="value">{limiterThreshold} dB</span>
                </div>
                <div class="control-row">
                  <span>Release:</span>
                  <input type="range" bind:value={limiterRelease} min="0.01" max="0.5" step="0.01" />
                  <span class="value">{(limiterRelease * 1000).toFixed(0)} ms</span>
                </div>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Bottom control bar -->
  <div class="control-bar">
    <div class="transport">
      <button class="import-btn" on:click={loadAudio} disabled={loading} title="Import Audio File">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
        <span>Import</span>
      </button>
      <button class="icon-btn" on:click={stopAudio} disabled={!audioBuffer} title="Stop">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg>
      </button>
      <button class="icon-btn play-btn" on:click={togglePlayPause} disabled={!audioBuffer} title={isPlaying ? 'Pause' : 'Play'}>
        {#if isPlaying}
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
        {/if}
      </button>
      <button class="export-btn" on:click={exportAudio} disabled={!audioBuffer || selectionStart === null || exportLoading} title={selectionStart !== null ? `Export selection (${getSelectionDuration().toFixed(2)}s)` : 'Shift+drag to select, then export'}>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        <span>{exportLoading ? 'Exporting...' : 'Export'}</span>
      </button>
    </div>

    <div class="time-display">
      {#if audioInfo}
        <span class="current-time">{formatTime(currentTime)}</span>
        <span class="separator">/</span>
        <span class="total-time">{formatTime(audioInfo.duration)}</span>
      {:else}
        <span class="current-time">0:00.0</span>
        <span class="separator">/</span>
        <span class="total-time">0:00.0</span>
      {/if}
    </div>

    <div class="volume-controls">
      <div class="volume-group">
        <label class="volume-label" for="volume-slider">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
        </label>
        <input type="range" id="volume-slider" class="volume-slider" bind:value={volume} min="0" max="1" step="0.01" title="Volume: {Math.round(volume * 100)}%" />
        <span class="volume-value">{Math.round(volume * 100)}%</span>
      </div>
      <div class="volume-group amplify">
        <label class="volume-label amplify-label" for="amplify-slider">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          AMP
        </label>
        <input type="range" id="amplify-slider" class="volume-slider amplify-slider" bind:value={amplify} min="1" max="5" step="0.1" title="Amplify: {Math.round(amplify * 100)}%" />
        <span class="volume-value amplify-value">{Math.round(amplify * 100)}%</span>
      </div>
    </div>

    <div class="filter-controls">
      <div class="filter-group">
        <label class="filter-label hp" for="hp-filter">HP:</label>
        <input type="number" id="hp-filter" class="filter-input hp" bind:value={highPassFreq} min="0" max={lowPassFreq - 100} step="50" />
      </div>
      <div class="filter-group">
        <label class="filter-label lp" for="lp-filter">LP:</label>
        <input type="number" id="lp-filter" class="filter-input lp" bind:value={lowPassFreq} min={highPassFreq + 100} max={maxFreq} step="50" />
      </div>
    </div>

    <div class="freq-control">
      <label>
        Max:
        <input type="number" bind:value={maxFreq} min="1000" max="22050" step="1000" />
        Hz
      </label>
    </div>

    <button class="meter-toggle" class:active={showMeter} on:click={() => showMeter = !showMeter} disabled={!audioBuffer} title="Toggle EQ Meter">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17h2v-7H3v7zm4 0h2V7H7v10zm4 0h2V4h-2v13zm4 0h2v-5h-2v5zm4 0h2v-9h-2v9z"/></svg>
    </button>

    <button class="effects-toggle" class:active={showEffects} on:click={() => showEffects = !showEffects} disabled={!audioBuffer} title="Toggle Dynamics Effects">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z"/></svg>
    </button>

    <button class="info-toggle" on:click={() => showInfo = !showInfo} title="Toggle Info Panel">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
    </button>

    <button class="fullscreen-toggle" on:click={toggleFullscreen} title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>
      {#if isFullscreen}
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
      {/if}
    </button>
  </div>

  <!-- Info panel overlay -->
  {#if showInfo}
    <div class="info-panel">
      <button class="close-btn" on:click={() => showInfo = false}>&times;</button>
      <h2>Audio Info</h2>
      {#if audioInfo}
        <p><strong>File:</strong> {filePath.split('/').pop()}</p>
        <p><strong>Duration:</strong> {formatTime(audioInfo.duration)}</p>
        <p><strong>Sample Rate:</strong> {audioInfo.sample_rate} Hz</p>
        <p><strong>Channels:</strong> {audioInfo.channels}</p>
      {:else}
        <p class="muted">No file loaded</p>
      {/if}

      <h2>Forensic Analysis</h2>
      {#if forensicData}
        <div class="metric">
          <span>SNR:</span>
          <span class:good={forensicData.snr_db > 30} class:warn={forensicData.snr_db <= 30 && forensicData.snr_db > 20} class:bad={forensicData.snr_db <= 20}>
            {forensicData.snr_db.toFixed(1)} dB
          </span>
        </div>
        <div class="metric">
          <span>Dynamic Range:</span>
          <span>{forensicData.dynamic_range_db.toFixed(1)} dB</span>
        </div>
        <div class="metric">
          <span>Clipping:</span>
          <span class:bad={forensicData.has_clipping}>
            {forensicData.has_clipping ? `Yes (${forensicData.clipped_count})` : 'None'}
          </span>
        </div>
        <div class="metric">
          <span>ENF Detected:</span>
          <span>{forensicData.enf_present ? `${forensicData.grid_freq} Hz` : 'No'}</span>
        </div>
        {#if forensicData.splice_times.length > 0}
          <div class="splices">
            <strong>Potential Splices:</strong>
            <ul>
              {#each forensicData.splice_times.slice(0, 5) as time}
                <li>{formatTime(time)}</li>
              {/each}
              {#if forensicData.splice_times.length > 5}
                <li>...and {forensicData.splice_times.length - 5} more</li>
              {/if}
            </ul>
          </div>
        {/if}
      {:else}
        <p class="muted">Load audio to analyze</p>
      {/if}
    </div>
  {/if}

  {#if error}
    <div class="error">{error}</div>
  {/if}
</main>

<style>
  :global(html) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #0f0f1a;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    background: #0f0f1a;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }

  :global(#app) {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: #0f0f1a;
  }

  :global(*) {
    box-sizing: border-box;
  }

  /* Fullscreen support */
  :global(:fullscreen) {
    background: #0f0f1a;
  }

  :global(::backdrop) {
    background: #0f0f1a;
  }

  main {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100vh;
    height: 100dvh;
    position: relative;
    background: #0f0f1a;
  }

  main.fullscreen {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 9999;
  }

  main.fullscreen .spectrogram-container {
    flex: 1;
    height: calc(100vh - 56px);
  }

  main.fullscreen .control-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 10000;
    background: #1a1a2e;
  }

  .spectrogram-container {
    flex: 1;
    width: 100%;
    position: relative;
    background: #1a1a2e;
    cursor: crosshair;
    overflow: hidden;
    /* Layout containment for better performance */
    contain: layout style;
  }

  .spectrogram-container.filter-hover {
    cursor: ns-resize;
  }

  .spectrogram-container.dragging {
    cursor: ns-resize;
  }

  canvas {
    width: 100%;
    height: 100%;
    display: block;
    /* GPU acceleration optimizations */
    will-change: contents;
    contain: strict;
    transform: translateZ(0);
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }

  .placeholder {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    color: #666;
    font-size: 1.25rem;
  }

  .loading-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.7);
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid #333;
    border-top-color: #4a90d9;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .control-bar {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.75rem 1rem;
    background: #1a1a2e;
    border-top: 1px solid #333;
    width: 100%;
    flex-shrink: 0;
  }

  .transport {
    display: flex;
    gap: 0.5rem;
  }

  .import-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: #4a90d9;
    color: #fff;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .import-btn:hover:not(:disabled) {
    background: #5a9fe9;
  }

  .import-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .import-btn svg {
    width: 18px;
    height: 18px;
  }

  .export-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: #00c8ff;
    color: #000;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .export-btn:hover:not(:disabled) {
    background: #40d8ff;
  }

  .export-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background: #2d2d44;
    color: #888;
  }

  .export-btn svg {
    width: 18px;
    height: 18px;
  }

  .icon-btn {
    width: 36px;
    height: 36px;
    padding: 6px;
    background: #2d2d44;
    color: #e0e0e0;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .icon-btn:hover:not(:disabled) {
    background: #3d3d54;
  }

  .icon-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .icon-btn svg {
    width: 20px;
    height: 20px;
  }

  .play-btn {
    width: 44px;
    height: 44px;
    background: #4a90d9;
    border-radius: 50%;
  }

  .play-btn:hover:not(:disabled) {
    background: #5a9fe9;
  }

  .play-btn svg {
    width: 24px;
    height: 24px;
  }

  .time-display {
    font-family: monospace;
    font-size: 1rem;
    min-width: 120px;
  }

  .current-time {
    color: #fff;
  }

  .separator {
    color: #666;
    margin: 0 0.25rem;
  }

  .total-time {
    color: #888;
  }

  .volume-controls {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .volume-group {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .volume-label {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    color: #888;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .volume-label svg {
    width: 18px;
    height: 18px;
  }

  .amplify-label {
    color: #fbbf24;
  }

  .volume-slider {
    width: 80px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: #2d2d44;
    border-radius: 2px;
    cursor: pointer;
  }

  .volume-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    background: #4a90d9;
    border-radius: 50%;
    cursor: pointer;
    transition: background 0.15s;
  }

  .volume-slider::-webkit-slider-thumb:hover {
    background: #5a9fe9;
  }

  .volume-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    background: #4a90d9;
    border: none;
    border-radius: 50%;
    cursor: pointer;
  }

  .amplify-slider::-webkit-slider-thumb {
    background: #fbbf24;
  }

  .amplify-slider::-webkit-slider-thumb:hover {
    background: #fcd34d;
  }

  .amplify-slider::-moz-range-thumb {
    background: #fbbf24;
  }

  .volume-value {
    font-size: 0.7rem;
    font-family: monospace;
    color: #888;
    min-width: 35px;
    text-align: right;
  }

  .amplify-value {
    color: #fbbf24;
    min-width: 40px;
  }

  .filter-controls {
    display: flex;
    gap: 1rem;
    margin-left: auto;
  }

  .filter-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .filter-label {
    font-size: 0.75rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .filter-label.hp {
    color: #ff00ff;
  }

  .filter-label.lp {
    color: #00ffff;
  }

  .filter-input {
    width: 60px;
    padding: 0.2rem 0.4rem;
    background: #2d2d44;
    color: white;
    border: 1px solid #444;
    border-radius: 4px;
    text-align: center;
    font-size: 0.75rem;
  }

  .filter-input.hp {
    border-color: rgba(255, 0, 255, 0.5);
  }

  .filter-input.hp:focus {
    border-color: #ff00ff;
    outline: none;
  }

  .filter-input.lp {
    border-color: rgba(0, 255, 255, 0.5);
  }

  .filter-input.lp:focus {
    border-color: #00ffff;
    outline: none;
  }

  .filter-input:disabled {
    opacity: 0.4;
  }

  .freq-control {
    margin-left: 0;
  }

  .freq-control label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: #888;
  }

  .freq-control input {
    width: 60px;
    padding: 0.2rem 0.4rem;
    background: #2d2d44;
    color: white;
    border: 1px solid #444;
    border-radius: 4px;
    text-align: center;
    font-size: 0.75rem;
  }

  .info-toggle {
    width: 36px;
    height: 36px;
    padding: 6px;
    background: transparent;
    color: #888;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .info-toggle:hover {
    background: #2d2d44;
    color: #e0e0e0;
  }

  .info-toggle svg {
    width: 24px;
    height: 24px;
  }

  .fullscreen-toggle {
    width: 36px;
    height: 36px;
    padding: 6px;
    background: transparent;
    color: #888;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .fullscreen-toggle:hover {
    background: #2d2d44;
    color: #e0e0e0;
  }

  .fullscreen-toggle svg {
    width: 24px;
    height: 24px;
  }

  .info-panel {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 280px;
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    background: rgba(22, 22, 42, 0.95);
    border: 1px solid #333;
    border-radius: 8px;
    padding: 1rem;
    z-index: 100;
  }

  .info-panel h2 {
    margin: 0 0 0.75rem 0;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
  }

  .info-panel h2:not(:first-of-type) {
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid #333;
  }

  .info-panel p {
    margin: 0.25rem 0;
    font-size: 0.875rem;
  }

  .close-btn {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 24px;
    height: 24px;
    background: transparent;
    color: #888;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    line-height: 1;
  }

  .close-btn:hover {
    color: #e0e0e0;
  }

  .muted {
    color: #666;
    font-style: italic;
  }

  .metric {
    display: flex;
    justify-content: space-between;
    padding: 0.25rem 0;
    font-size: 0.875rem;
  }

  .good { color: #22c55e; }
  .warn { color: #eab308; }
  .bad { color: #ef4444; }

  .splices ul {
    margin: 0.5rem 0 0 1rem;
    padding: 0;
    font-size: 0.75rem;
  }

  .splices li {
    margin: 0.25rem 0;
  }

  .error {
    position: absolute;
    bottom: 60px;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.75rem 1.5rem;
    background: #7f1d1d;
    color: #fecaca;
    border-radius: 4px;
    z-index: 100;
  }

  /* Level Meter Styles */
  .level-meter-panel {
    position: absolute;
    bottom: 10px;
    right: 70px;
    width: 280px;
    height: 100px;
    background: rgba(22, 22, 42, 0.95);
    border: 1px solid #333;
    border-radius: 8px;
    overflow: hidden;
    z-index: 50;
  }

  .meter-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.25rem 0.5rem;
    background: #2d2d44;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: #888;
  }

  .meter-close {
    background: transparent;
    border: none;
    color: #666;
    font-size: 1rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .meter-close:hover {
    color: #e0e0e0;
  }

  .meter-canvas {
    width: 100%;
    height: calc(100% - 24px);
    display: block;
    /* GPU acceleration for real-time meter */
    will-change: contents;
    contain: strict;
    transform: translateZ(0);
  }

  .meter-toggle {
    width: 36px;
    height: 36px;
    padding: 6px;
    background: transparent;
    color: #888;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .meter-toggle:hover:not(:disabled) {
    background: #2d2d44;
    color: #e0e0e0;
  }

  .meter-toggle.active {
    color: #22c55e;
  }

  .meter-toggle:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .meter-toggle svg {
    width: 24px;
    height: 24px;
  }

  /* Effects Panel Styles */
  .effects-panel {
    position: absolute;
    top: 10px;
    left: 10px;
    width: 300px;
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    background: rgba(22, 22, 42, 0.95);
    border: 1px solid #333;
    border-radius: 8px;
    z-index: 100;
  }

  .effects-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background: #2d2d44;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: #888;
    border-bottom: 1px solid #333;
  }

  .effects-close {
    background: transparent;
    border: none;
    color: #666;
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .effects-close:hover {
    color: #e0e0e0;
  }

  .effects-content {
    padding: 0.5rem;
  }

  .effect-section {
    background: rgba(45, 45, 68, 0.5);
    border-radius: 6px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .effect-section:last-child {
    margin-bottom: 0;
  }

  .effect-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 500;
  }

  .effect-toggle input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: #4a90d9;
    cursor: pointer;
  }

  .effect-name {
    color: #e0e0e0;
  }

  .effect-controls {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .control-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
    font-size: 0.7rem;
    color: #aaa;
  }

  .control-row:last-child {
    margin-bottom: 0;
  }

  .control-row span:first-child {
    min-width: 70px;
  }

  .control-row input[type="range"] {
    flex: 1;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: #3d3d54;
    border-radius: 2px;
    cursor: pointer;
  }

  .control-row input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    background: #4a90d9;
    border-radius: 50%;
    cursor: pointer;
  }

  .control-row input[type="range"]::-moz-range-thumb {
    width: 12px;
    height: 12px;
    background: #4a90d9;
    border: none;
    border-radius: 50%;
    cursor: pointer;
  }

  .control-row .value {
    min-width: 55px;
    text-align: right;
    font-family: monospace;
    color: #4a90d9;
  }

  .control-row.info {
    color: #666;
    font-style: italic;
    justify-content: flex-end;
  }

  .control-row.band-low .value { color: #22c55e; }
  .control-row.band-mid .value { color: #eab308; }
  .control-row.band-high .value { color: #ef4444; }

  .control-row.band-low input[type="range"]::-webkit-slider-thumb { background: #22c55e; }
  .control-row.band-mid input[type="range"]::-webkit-slider-thumb { background: #eab308; }
  .control-row.band-high input[type="range"]::-webkit-slider-thumb { background: #ef4444; }

  .control-row.band-low input[type="range"]::-moz-range-thumb { background: #22c55e; }
  .control-row.band-mid input[type="range"]::-moz-range-thumb { background: #eab308; }
  .control-row.band-high input[type="range"]::-moz-range-thumb { background: #ef4444; }

  .effects-toggle {
    width: 36px;
    height: 36px;
    padding: 6px;
    background: transparent;
    color: #888;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .effects-toggle:hover:not(:disabled) {
    background: #2d2d44;
    color: #e0e0e0;
  }

  .effects-toggle.active {
    color: #fbbf24;
  }

  .effects-toggle:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .effects-toggle svg {
    width: 24px;
    height: 24px;
  }

  /* Dynamics Range Panel Styles */
  .dynamics-range-panel {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(22, 22, 42, 0.95);
    border: 1px solid #333;
    border-radius: 8px;
    padding: 0.5rem 1rem;
    z-index: 60;
    min-width: 380px;
  }

  .dynamics-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: #888;
  }

  .dynamics-values {
    color: #fbbf24;
    font-family: monospace;
  }

  .dynamics-slider-container {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .dynamics-scale {
    display: flex;
    justify-content: space-between;
    font-size: 0.65rem;
    color: #666;
    font-family: monospace;
  }

  .dynamics-track {
    position: relative;
    height: 8px;
    background: #2d2d44;
    border-radius: 4px;
    overflow: hidden;
  }

  .dynamics-range-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    background: linear-gradient(90deg, #ff6b6b, #fbbf24, #22c55e);
    border-radius: 4px;
  }

  .dynamics-inputs {
    display: flex;
    gap: 1rem;
    justify-content: center;
  }

  .dynamics-input-group {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .dynamics-input-group label {
    font-size: 0.7rem;
    color: #888;
    min-width: 30px;
  }

  .dynamics-slider {
    width: 80px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: #3d3d54;
    border-radius: 2px;
    cursor: pointer;
  }

  .dynamics-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    cursor: pointer;
  }

  .dynamics-slider.low::-webkit-slider-thumb {
    background: #ff6b6b;
  }

  .dynamics-slider.high::-webkit-slider-thumb {
    background: #22c55e;
  }

  .dynamics-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: none;
    border-radius: 50%;
    cursor: pointer;
  }

  .dynamics-slider.low::-moz-range-thumb {
    background: #ff6b6b;
  }

  .dynamics-slider.high::-moz-range-thumb {
    background: #22c55e;
  }

  .dynamics-number {
    width: 50px;
    padding: 0.15rem 0.3rem;
    background: #2d2d44;
    color: #fbbf24;
    border: 1px solid #444;
    border-radius: 4px;
    text-align: center;
    font-size: 0.7rem;
    font-family: monospace;
  }

  .dynamics-number:focus {
    border-color: #fbbf24;
    outline: none;
  }

  .dynamics-unit {
    font-size: 0.65rem;
    color: #666;
  }

  .dynamics-reset {
    align-self: center;
    padding: 0.25rem 0.75rem;
    background: #3d3d54;
    color: #888;
    border: none;
    border-radius: 4px;
    font-size: 0.65rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .dynamics-reset:hover {
    background: #4d4d64;
    color: #e0e0e0;
  }
</style>
