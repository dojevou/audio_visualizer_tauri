# Audio Visualizer

A desktop audio visualizer with forensic analysis capabilities, built with Tauri, Svelte, and Rust.

## Features

- **Spectrogram Visualization** - Real-time frequency analysis with parallel FFT processing
- **Audio Playback** - Play loaded audio files with waveform display
- **Forensic Analysis**:
  - ENF (Electrical Network Frequency) detection for 50Hz/60Hz power grid hum
  - Splice/edit detection via discontinuity analysis
  - Clipping detection
  - SNR (Signal-to-Noise Ratio) estimation
  - Dynamic range measurement
- **Audio Export** - Export selected time ranges to WAV files
- **Multi-format Support** - WAV, MP3, FLAC, OGG, and more via Symphonia

## Screenshots

*Coming soon*

## Tech Stack

**Frontend:**
- Svelte 5
- TypeScript
- Vite

**Backend:**
- Rust
- Tauri 2.0
- Symphonia (audio decoding)
- RealFFT (FFT processing)
- Rayon (parallel processing)
- Hound (WAV export)

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libasound2-dev
```

### macOS
```bash
xcode-select --install
```

### Windows
Install [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

## Installation

```bash
# Clone the repository
git clone https://github.com/dojevou/audio_visualizer_tauri.git
cd audio_visualizer_tauri

# Install frontend dependencies
cd frontend
npm install

# Run in development mode
npm run tauri dev
```

## Building for Production

```bash
cd frontend
npm run tauri build
```

The built application will be in `frontend/src-tauri/target/release/bundle/`.

## Usage

1. Click **Import** to load an audio file
2. The spectrogram will be computed automatically
3. Use the playback controls to navigate the audio
4. Click **Analyze** to run forensic analysis
5. Select a time range and click **Export** to save a portion

## Forensic Analysis Details

### ENF Detection
Detects presence of power grid hum (50Hz or 60Hz) which can be used to verify recording authenticity and estimate recording location/time.

### Splice Detection
Identifies potential edit points by analyzing sample discontinuities that exceed local statistical norms.

### Quality Metrics
- **SNR**: Estimated signal-to-noise ratio in dB
- **Dynamic Range**: Peak-to-RMS ratio in dB
- **Clipping**: Detects samples exceeding 99% of full scale

## Project Structure

```
audio_visualizer_tauri/
├── frontend/
│   ├── src/              # Svelte frontend
│   │   ├── App.svelte    # Main application
│   │   └── lib/          # Utilities (logger, etc.)
│   ├── src-tauri/        # Rust backend
│   │   ├── src/main.rs   # Tauri commands & audio processing
│   │   └── Cargo.toml    # Rust dependencies
│   └── package.json      # Node dependencies
└── README.md
```

## License

MIT
