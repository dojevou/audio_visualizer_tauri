// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rayon::prelude::*;
use realfft::RealFftPlanner;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use log::{debug, info, warn};
use tauri_plugin_log::{Target, TargetKind};

/// Audio data state shared across commands
struct AudioState {
    samples: Mutex<Vec<f32>>,           // Mono samples for analysis
    samples_interleaved: Mutex<Vec<f32>>, // Original interleaved for playback
    sample_rate: Mutex<u32>,
    channels: Mutex<usize>,
    spectrogram: Mutex<Vec<Vec<f32>>>,
    spec_times: Mutex<Vec<f32>>,
    forensic_data: Mutex<ForensicData>,
}

#[derive(Default, Clone, Serialize)]
struct ForensicData {
    enf_present: bool,
    enf_strength_db: f32,
    grid_freq: f32,
    splice_times: Vec<f32>,
    snr_db: f32,
    dynamic_range_db: f32,
    has_clipping: bool,
    clipped_count: usize,
}

#[derive(Serialize)]
struct AudioInfo {
    duration: f32,
    sample_rate: u32,
    channels: usize,
}

#[derive(Serialize)]
struct SpectrogramData {
    data: Vec<Vec<f32>>,
    times: Vec<f32>,
    max_freq: f32,
}

#[derive(Serialize)]
struct AudioSamples {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: usize,
}

/// Load an audio file and compute spectrogram
#[tauri::command]
async fn load_audio(path: String, state: State<'_, AudioState>) -> Result<AudioInfo, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    info!("Loading audio: {}", path);
    let file = std::fs::File::open(&path).map_err(|e| {
        warn!("Failed to open file: {}", e);
        e.to_string()
    })?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = PathBuf::from(&path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    debug!("Probing format...");
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| {
            warn!("Probe failed: {}", e);
            e.to_string()
        })?;

    let mut format = probed.format;
    let track = format.default_track().ok_or("No audio track found")?;
    info!("Found track: {}Hz, {} channels",
        track.codec_params.sample_rate.unwrap_or(0),
        track.codec_params.channels.map(|c| c.count()).unwrap_or(0));
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let track_id = track.id;
    let mut samples = Vec::new();
    let mut interleaved = Vec::new();
    let mut actual_channels = channels;

    loop {
        match format.next_packet() {
            Ok(packet) => {
                if packet.track_id() != track_id {
                    continue;
                }
                match decoder.decode(&packet) {
                    Ok(decoded) => {
                        let spec = *decoded.spec();
                        let ch = spec.channels.count();
                        let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                        sample_buf.copy_interleaved_ref(decoded);

                        // Store interleaved samples for playback
                        interleaved.extend_from_slice(sample_buf.samples());
                        actual_channels = ch;

                        // Convert to mono for analysis
                        for chunk in sample_buf.samples().chunks(ch) {
                            let mono: f32 = chunk.iter().sum::<f32>() / ch as f32;
                            samples.push(mono);
                        }
                    }
                    Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                    Err(_) => break,
                }
            }
            Err(_) => break,
        }
    }

    let duration = samples.len() as f32 / sample_rate as f32;
    info!("Decoded {} samples, duration: {:.2}s", samples.len(), duration);

    // Store in state
    *state.samples.lock().unwrap() = samples;
    *state.samples_interleaved.lock().unwrap() = interleaved;
    *state.sample_rate.lock().unwrap() = sample_rate;
    *state.channels.lock().unwrap() = actual_channels;

    Ok(AudioInfo {
        duration,
        sample_rate,
        channels: actual_channels,
    })
}

/// Compute spectrogram using parallel processing
#[tauri::command]
async fn compute_spectrogram(max_freq: f32, state: State<'_, AudioState>) -> Result<SpectrogramData, String> {
    info!("Starting spectrogram computation...");
    let samples = state.samples.lock().unwrap().clone();
    let sample_rate = *state.sample_rate.lock().unwrap();

    if samples.is_empty() {
        return Err("No audio loaded".to_string());
    }
    debug!("Processing {} samples for spectrogram", samples.len());

    let n_fft = 2048;
    let hop_length = 512;
    let sr = sample_rate as f32;

    // Hann window
    let window: Vec<f32> = (0..n_fft)
        .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n_fft as f32).cos()))
        .collect();

    // Limit frequency bins
    let max_bin = ((max_freq / sr) * n_fft as f32) as usize;
    let max_bin = max_bin.min(n_fft / 2 + 1);

    // Frame positions
    let frame_starts: Vec<usize> = (0..)
        .map(|i| i * hop_length)
        .take_while(|&start| start + n_fft <= samples.len())
        .collect();

    debug!("Computing {} FFT frames...", frame_starts.len());

    // Parallel FFT computation
    let results: Vec<(f32, Vec<f32>)> = frame_starts
        .par_iter()
        .map(|&frame_start| {
            let mut planner = RealFftPlanner::<f32>::new();
            let fft = planner.plan_fft_forward(n_fft);

            let mut input: Vec<f32> = samples[frame_start..frame_start + n_fft]
                .iter()
                .zip(window.iter())
                .map(|(&s, &w)| s * w)
                .collect();

            let mut spectrum = fft.make_output_vec();
            fft.process(&mut input, &mut spectrum).unwrap();

            let magnitudes: Vec<f32> = spectrum[..max_bin]
                .iter()
                .map(|c| {
                    let mag = (c.re * c.re + c.im * c.im).sqrt();
                    20.0 * (mag + 1e-10).log10()
                })
                .collect();

            (frame_start as f32 / sr, magnitudes)
        })
        .collect();

    let mut times = Vec::new();
    let mut data = Vec::new();
    for (t, mags) in results {
        times.push(t);
        data.push(mags);
    }

    info!("Spectrogram complete: {} frames x {} bins", data.len(), data.first().map(|d| d.len()).unwrap_or(0));

    // Store in state
    *state.spectrogram.lock().unwrap() = data.clone();
    *state.spec_times.lock().unwrap() = times.clone();

    Ok(SpectrogramData {
        data,
        times,
        max_freq,
    })
}

/// Run forensic analysis
#[tauri::command]
async fn analyze_forensics(state: State<'_, AudioState>) -> Result<ForensicData, String> {
    let samples = state.samples.lock().unwrap().clone();
    let sample_rate = *state.sample_rate.lock().unwrap();

    if samples.is_empty() {
        return Err("No audio loaded".to_string());
    }

    let sr = sample_rate as f32;
    let mut forensic = ForensicData::default();

    // Quality metrics
    let peak = samples.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
    let rms = (samples.iter().map(|&s| s * s).sum::<f32>() / samples.len() as f32).sqrt();

    if rms > 0.0 {
        forensic.dynamic_range_db = 20.0 * (peak / rms).log10();
    }

    // Clipping detection
    let clip_threshold = 0.99;
    forensic.clipped_count = samples.iter().filter(|&&s| s.abs() > clip_threshold).count();
    forensic.has_clipping = forensic.clipped_count > samples.len() / 10000;

    // SNR estimation
    let frame_size = (0.02 * sr) as usize;
    let mut frame_powers: Vec<f32> = samples
        .chunks(frame_size)
        .map(|chunk| chunk.iter().map(|&s| s * s).sum::<f32>() / chunk.len() as f32)
        .collect();

    if !frame_powers.is_empty() {
        frame_powers.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let noise_power = frame_powers[frame_powers.len() / 20].max(1e-10);
        let signal_power = frame_powers[frame_powers.len() * 9 / 10];
        forensic.snr_db = 10.0 * (signal_power / noise_power).log10();
    }

    // Splice detection
    let diff: Vec<f32> = samples.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
    let window_size = (0.01 * sr) as usize;
    let threshold_mult = 8.0;

    let mut i = window_size;
    while i < diff.len() - window_size {
        let local_mean: f32 = diff[i - window_size..i + window_size].iter().sum::<f32>()
            / (2 * window_size) as f32;
        if diff[i] > local_mean * threshold_mult && diff[i] > 0.1 {
            forensic.splice_times.push(i as f32 / sr);
            i += window_size * 2;
        } else {
            i += 1;
        }
    }

    // ENF detection - analyze 50Hz (Europe/Asia) and 60Hz (Americas) power line hum
    let spectrogram = state.spectrogram.lock().unwrap();

    if !spectrogram.is_empty() {
        let max_freq = 8000.0; // Default max frequency
        let n_freqs = spectrogram.first().map(|f| f.len()).unwrap_or(0);

        for grid_freq in [50.0f32, 60.0] {
            let nyq = sr / 2.0;
            if grid_freq >= nyq || n_freqs < 3 {
                continue;
            }

            // Find the frequency bin for the grid frequency
            let target_bin = ((grid_freq / max_freq) * n_freqs as f32) as usize;
            if target_bin >= n_freqs || target_bin < 2 {
                continue;
            }

            // Extract energy at ENF frequency over time
            let mut enf_energies: Vec<f32> = Vec::new();
            for frame in spectrogram.iter() {
                if target_bin < frame.len() {
                    // Average over a small frequency range around target
                    let low = target_bin.saturating_sub(1);
                    let high = (target_bin + 2).min(frame.len());
                    let energy: f32 = frame[low..high].iter().sum::<f32>() / (high - low) as f32;
                    enf_energies.push(energy);
                }
            }

            if enf_energies.is_empty() {
                continue;
            }

            // Check if ENF is present (energy significantly above background)
            let avg_enf = enf_energies.iter().sum::<f32>() / enf_energies.len() as f32;
            let total_bins: usize = spectrogram.iter().map(|f| f.len()).sum();
            let avg_all: f32 = if total_bins > 0 {
                spectrogram.iter().flat_map(|f| f.iter()).sum::<f32>() / total_bins as f32
            } else {
                0.0
            };

            let enf_strength = avg_enf - avg_all;
            if enf_strength > 5.0 {  // At least 5dB above average
                forensic.enf_present = true;
                forensic.grid_freq = grid_freq;
                forensic.enf_strength_db = enf_strength;
                break;
            }
        }
    }

    *state.forensic_data.lock().unwrap() = forensic.clone();
    Ok(forensic)
}

/// Get current forensic data
#[tauri::command]
fn get_forensic_data(state: State<'_, AudioState>) -> ForensicData {
    state.forensic_data.lock().unwrap().clone()
}

/// Get audio samples for playback (limited to avoid IPC crashes with large files)
#[tauri::command]
fn get_audio_samples(state: State<'_, AudioState>) -> Result<AudioSamples, String> {
    let samples = state.samples_interleaved.lock().unwrap().clone();
    let sample_rate = *state.sample_rate.lock().unwrap();
    let channels = *state.channels.lock().unwrap();

    if samples.is_empty() {
        return Err("No audio loaded".to_string());
    }

    // Limit transfer size to prevent IPC crashes (max ~5 million samples = ~60s stereo)
    const MAX_SAMPLES: usize = 5_000_000;
    let limited_samples = if samples.len() > MAX_SAMPLES {
        warn!("Audio too large for full playback ({} samples), limiting to {} samples", samples.len(), MAX_SAMPLES);
        samples[..MAX_SAMPLES].to_vec()
    } else {
        samples
    };

    Ok(AudioSamples {
        samples: limited_samples,
        sample_rate,
        channels,
    })
}

/// Get audio samples in chunks for large files
#[tauri::command]
fn get_audio_samples_chunk(chunk_index: usize, chunk_size: usize, state: State<'_, AudioState>) -> Result<AudioSamples, String> {
    let samples = state.samples_interleaved.lock().unwrap();
    let sample_rate = *state.sample_rate.lock().unwrap();
    let channels = *state.channels.lock().unwrap();

    if samples.is_empty() {
        return Err("No audio loaded".to_string());
    }

    let start = chunk_index * chunk_size;
    let end = (start + chunk_size).min(samples.len());

    if start >= samples.len() {
        return Err("Chunk index out of range".to_string());
    }

    Ok(AudioSamples {
        samples: samples[start..end].to_vec(),
        sample_rate,
        channels,
    })
}

/// Get total sample count for chunked loading
#[tauri::command]
fn get_audio_sample_count(state: State<'_, AudioState>) -> Result<usize, String> {
    let samples = state.samples_interleaved.lock().unwrap();
    if samples.is_empty() {
        return Err("No audio loaded".to_string());
    }
    Ok(samples.len())
}

/// Export selected audio range to WAV file
#[tauri::command]
async fn export_audio(
    output_path: String,
    start_time: f32,
    end_time: f32,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    info!("Exporting audio: {:.3}s - {:.3}s to {}", start_time, end_time, output_path);

    let samples = state.samples_interleaved.lock().unwrap().clone();
    let sample_rate = *state.sample_rate.lock().unwrap();
    let channels = *state.channels.lock().unwrap();

    if samples.is_empty() {
        return Err("No audio loaded".to_string());
    }

    // Calculate sample indices for the selection
    let samples_per_frame = channels;
    let start_frame = (start_time * sample_rate as f32) as usize;
    let end_frame = (end_time * sample_rate as f32) as usize;
    let start_sample = start_frame * samples_per_frame;
    let end_sample = (end_frame * samples_per_frame).min(samples.len());

    if start_sample >= end_sample {
        return Err("Invalid selection range".to_string());
    }

    let selected_samples = &samples[start_sample..end_sample];
    info!("Exporting {} samples ({} frames)", selected_samples.len(), selected_samples.len() / channels);

    // Create WAV file
    let spec = hound::WavSpec {
        channels: channels as u16,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let mut writer = hound::WavWriter::create(&output_path, spec)
        .map_err(|e| format!("Failed to create WAV file: {}", e))?;

    for &sample in selected_samples {
        writer.write_sample(sample)
            .map_err(|e| format!("Failed to write sample: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Failed to finalize WAV file: {}", e))?;

    info!("Export complete: {}", output_path);
    Ok(())
}

fn main() {
    // Configure logging with tauri-plugin-log
    // Logs go to: stdout, webview console, and optionally log files
    let log_plugin = tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Webview),
            Target::new(TargetKind::LogDir { file_name: None }), // Writes to app log directory
        ])
        .level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        .level_for("symphonia", log::LevelFilter::Warn) // Reduce noise from audio lib
        .level_for("rodio", log::LevelFilter::Warn)
        .build();

    tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AudioState {
            samples: Mutex::new(Vec::new()),
            samples_interleaved: Mutex::new(Vec::new()),
            sample_rate: Mutex::new(44100),
            channels: Mutex::new(2),
            spectrogram: Mutex::new(Vec::new()),
            spec_times: Mutex::new(Vec::new()),
            forensic_data: Mutex::new(ForensicData::default()),
        })
        .invoke_handler(tauri::generate_handler![
            load_audio,
            compute_spectrogram,
            analyze_forensics,
            get_forensic_data,
            get_audio_samples,
            get_audio_samples_chunk,
            get_audio_sample_count,
            export_audio,
        ])
        .setup(|_app| {
            info!("Audio Visualizer started successfully");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
