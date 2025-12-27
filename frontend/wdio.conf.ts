import type { Options } from '@wdio/types';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

let tauriDriver: ChildProcess;

export const config: Options.Testrunner = {
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: {
      transpileOnly: true,
      project: './tsconfig.json',
    },
  },
  specs: ['./test/specs/**/*.ts'],
  exclude: [],
  maxInstances: 1,
  capabilities: [{
    // Use tauri-driver native capabilities
    'webkitgtk:browserOptions': {
      binary: path.resolve('./src-tauri/target/release/audio-visualizer-tauri'),
    },
  }],
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  onPrepare: () => new Promise((resolve) => {
    tauriDriver = spawn('tauri-driver', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    tauriDriver.stdout?.on('data', (data) => {
      console.log('[tauri-driver stdout]', data.toString());
    });

    tauriDriver.stderr?.on('data', (data) => {
      console.log('[tauri-driver stderr]', data.toString());
    });

    // Wait for driver to start
    setTimeout(() => resolve(undefined), 3000);
  }),

  onComplete: () => {
    if (tauriDriver) {
      tauriDriver.kill();
    }
  },

  hostname: '127.0.0.1',
  port: 4444,
};
