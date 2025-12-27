describe('Audio Visualizer Tauri App', () => {
  it('should display the application title', async () => {
    const title = await browser.getTitle();
    expect(title).toContain('Audio Visualizer');
  });

  it('should have the canvas element for spectrogram', async () => {
    const canvas = await $('canvas');
    await expect(canvas).toBeDisplayed();
  });

  it('should have the spectrogram container', async () => {
    const container = await $('.spectrogram-container');
    await expect(container).toBeDisplayed();
  });

  it('should show placeholder text when no file loaded', async () => {
    const placeholder = await $('p=Load an audio file to view spectrogram');
    await expect(placeholder).toBeDisplayed();
  });

  it('should have the control bar', async () => {
    const controlBar = await $('.control-bar');
    await expect(controlBar).toBeDisplayed();
  });

  it('should have transport buttons', async () => {
    const transport = await $('.transport');
    await expect(transport).toBeDisplayed();

    // Should have 4 buttons: open, stop, play, export
    const buttons = await transport.$$('button');
    expect(buttons.length).toBe(4);
  });

  it('should have the play button', async () => {
    const playBtn = await $('.play-btn');
    await expect(playBtn).toBeDisplayed();
  });

  it('should have time display', async () => {
    const timeDisplay = await $('.time-display');
    await expect(timeDisplay).toBeDisplayed();

    const currentTime = await $('.current-time');
    await expect(currentTime).toHaveText('0:00.0');
  });

  it('should have the frequency input control', async () => {
    const freqControl = await $('.freq-control');
    await expect(freqControl).toBeDisplayed();

    const input = await freqControl.$('input[type="number"]');
    await expect(input).toBeDisplayed();
    const value = await input.getValue();
    expect(value).toBe('8000');
  });

  it('should allow changing frequency input', async () => {
    const input = await $('.freq-control input[type="number"]');
    await input.clearValue();
    await input.setValue('16000');
    const value = await input.getValue();
    expect(value).toBe('16000');
  });

  it('should have info toggle button', async () => {
    const infoToggle = await $('.info-toggle');
    await expect(infoToggle).toBeDisplayed();
  });

  it('should toggle info panel when clicking info button', async () => {
    const infoToggle = await $('.info-toggle');

    // Info panel should not be visible initially
    let infoPanel = await $('.info-panel');
    await expect(infoPanel).not.toBeDisplayed();

    // Click to show info panel
    await infoToggle.click();
    await browser.pause(300);

    infoPanel = await $('.info-panel');
    await expect(infoPanel).toBeDisplayed();

    // Should have Audio Info and Forensic Analysis headings
    const audioInfoHeading = await infoPanel.$('h2=Audio Info');
    await expect(audioInfoHeading).toBeDisplayed();

    const forensicHeading = await infoPanel.$('h2=Forensic Analysis');
    await expect(forensicHeading).toBeDisplayed();

    // Click to hide info panel
    await infoToggle.click();
    await browser.pause(300);

    infoPanel = await $('.info-panel');
    await expect(infoPanel).not.toBeDisplayed();
  });

  it('should have play button disabled when no audio loaded', async () => {
    const playBtn = await $('.play-btn');
    const isDisabled = await playBtn.getAttribute('disabled');
    expect(isDisabled).toBe('true');
  });

  it('should have crosshair cursor on spectrogram container', async () => {
    const container = await $('.spectrogram-container');
    const cursor = await container.getCSSProperty('cursor');
    expect(cursor.value).toBe('crosshair');
  });
});
