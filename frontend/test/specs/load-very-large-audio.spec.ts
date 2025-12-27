describe('Very Large Audio Loading Test', () => {
  it('should load a 200+ second audio file without crashing', async () => {
    await browser.pause(1000);

    // Load very large audio file (200 seconds, stereo - similar to user's file)
    const result = await browser.execute(async () => {
      // @ts-ignore
      const { invoke } = window.__TAURI_INTERNALS__;
      try {
        console.log('Loading 200s audio...');
        const audioInfo = await invoke('load_audio', { path: '/tmp/test_audio_200s.wav' });
        console.log('Audio loaded:', audioInfo);
        return { success: true, audioInfo };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    });

    console.log('Load result:', result);
    expect(result.success).toBe(true);

    await browser.pause(500);

    // Compute spectrogram
    const spectrogramResult = await browser.execute(async () => {
      // @ts-ignore
      const { invoke } = window.__TAURI_INTERNALS__;
      try {
        console.log('Computing spectrogram...');
        const specData = await invoke('compute_spectrogram', { maxFreq: 8000 });
        console.log('Spectrogram frames:', specData.data.length);
        return { success: true, frames: specData.data.length };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    });

    console.log('Spectrogram result:', spectrogramResult);
    expect(spectrogramResult.success).toBe(true);

    // Run forensic analysis
    const forensicResult = await browser.execute(async () => {
      // @ts-ignore
      const { invoke } = window.__TAURI_INTERNALS__;
      try {
        console.log('Running forensic analysis...');
        const forensicData = await invoke('analyze_forensics');
        console.log('Forensics done:', forensicData);
        return { success: true, forensicData };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    });

    console.log('Forensic result:', forensicResult);
    expect(forensicResult.success).toBe(true);

    // Get audio samples (this transfers large data - ~17.6M samples for 200s stereo)
    const samplesResult = await browser.execute(async () => {
      // @ts-ignore
      const { invoke } = window.__TAURI_INTERNALS__;
      try {
        console.log('Getting audio samples (this may take a while for large files)...');
        const samples = await invoke('get_audio_samples');
        console.log('Got samples:', samples.samples.length);
        return { success: true, sampleCount: samples.samples.length };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    });

    console.log('Samples result:', samplesResult);
    expect(samplesResult.success).toBe(true);

    // Wait and check app is still responsive
    await browser.pause(3000);

    const title = await browser.getTitle();
    console.log('App still responsive, title:', title);
    expect(title).toContain('Audio Visualizer');

    await browser.saveScreenshot('/tmp/very_large_audio_screenshot.png');
  });
});
