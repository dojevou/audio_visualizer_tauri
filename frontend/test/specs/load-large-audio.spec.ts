describe('Large Audio Loading Test', () => {
  it('should load a larger audio file without crashing', async () => {
    await browser.pause(1000);

    // Load larger audio file
    const result = await browser.execute(async () => {
      // @ts-ignore
      const { invoke } = window.__TAURI_INTERNALS__;
      try {
        console.log('Loading audio...');
        const audioInfo = await invoke('load_audio', { path: '/tmp/test_audio_long.wav' });
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

    // Get audio samples (this transfers large data)
    const samplesResult = await browser.execute(async () => {
      // @ts-ignore
      const { invoke } = window.__TAURI_INTERNALS__;
      try {
        console.log('Getting audio samples...');
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
    await browser.pause(2000);
    
    const title = await browser.getTitle();
    console.log('App still responsive, title:', title);
    expect(title).toContain('Audio Visualizer');

    await browser.saveScreenshot('/tmp/large_audio_screenshot.png');
  });
});
