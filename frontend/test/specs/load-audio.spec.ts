describe('Audio Loading Test', () => {
  it('should load an audio file and display spectrogram', async () => {
    // Wait for app to be ready
    await browser.pause(1000);

    // Use Tauri's invoke to load audio directly (bypassing file dialog)
    const result = await browser.execute(async () => {
      // @ts-ignore - Tauri API available in app context
      const { invoke } = window.__TAURI_INTERNALS__;

      try {
        // Load the test audio file
        const audioInfo = await invoke('load_audio', { path: '/tmp/test_audio.wav' });
        return { success: true, audioInfo };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    });

    console.log('Load result:', result);
    expect(result.success).toBe(true);

    // Wait for spectrogram computation
    await browser.pause(500);

    // Compute spectrogram
    const spectrogramResult = await browser.execute(async () => {
      // @ts-ignore
      const { invoke } = window.__TAURI_INTERNALS__;

      try {
        const specData = await invoke('compute_spectrogram', { maxFreq: 8000 });
        return { success: true, frames: specData.data.length };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    });

    console.log('Spectrogram result:', spectrogramResult);
    expect(spectrogramResult.success).toBe(true);
    expect(spectrogramResult.frames).toBeGreaterThan(0);

    // Run forensic analysis
    const forensicResult = await browser.execute(async () => {
      // @ts-ignore
      const { invoke } = window.__TAURI_INTERNALS__;

      try {
        const forensicData = await invoke('analyze_forensics');
        return { success: true, forensicData };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    });

    console.log('Forensic result:', forensicResult);
    expect(forensicResult.success).toBe(true);

    // Take a screenshot of the result
    await browser.pause(1000);
    await browser.saveScreenshot('/tmp/audio_visualizer_screenshot.png');
    console.log('Screenshot saved to /tmp/audio_visualizer_screenshot.png');
  });
});
