import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import App from '../App.svelte';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn()
}));

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the import button', () => {
    render(App);
    expect(screen.getByText('Import')).toBeTruthy();
  });

  it('renders import button with correct title', () => {
    render(App);
    expect(screen.getByTitle('Import Audio File')).toBeTruthy();
  });

  it('has frequency input with default value', () => {
    render(App);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('8000');
  });

  it('renders the canvas', () => {
    render(App);
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeTruthy();
  });

  it('renders stop button', () => {
    render(App);
    expect(screen.getByTitle('Stop')).toBeTruthy();
  });

  it('renders play button', () => {
    render(App);
    expect(screen.getByTitle('Play')).toBeTruthy();
  });
});

describe('Spectrogram rendering', () => {
  it('shows placeholder when no audio loaded', () => {
    render(App);
    expect(screen.getByText('Load an audio file to view spectrogram')).toBeTruthy();
  });
});

describe('Initial state', () => {
  it('shows Max Freq label', () => {
    render(App);
    expect(screen.getByText(/Max Freq/)).toBeTruthy();
  });

  it('shows time display with zeros', () => {
    render(App);
    const timeElements = screen.getAllByText('0:00.0');
    expect(timeElements.length).toBe(2); // current time and total time
  });

  it('has info toggle button', () => {
    render(App);
    expect(screen.getByTitle('Toggle Info Panel')).toBeTruthy();
  });

  it('does not show metrics before loading audio', () => {
    render(App);
    // Forensic metrics only show after audio is loaded and info panel opened
    expect(screen.queryByText('SNR:')).toBeNull();
  });

  it('transport buttons are disabled initially', () => {
    render(App);
    const stopBtn = screen.getByTitle('Stop') as HTMLButtonElement;
    const playBtn = screen.getByTitle('Play') as HTMLButtonElement;
    expect(stopBtn.disabled).toBe(true);
    expect(playBtn.disabled).toBe(true);
  });

  it('import button is enabled', () => {
    render(App);
    const importBtn = screen.getByTitle('Import Audio File') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(false);
  });
});
