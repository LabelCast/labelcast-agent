'use strict';

/**
 * install-service.js
 *
 * Installs the print agent as a Windows Service using node-windows.
 * Run once with Administrator privileges:
 *
 *   npm install -g node-windows
 *   npm link node-windows
 *   node scripts/install-service.js
 *
 * To uninstall:
 *   node scripts/install-service.js --uninstall
 */

const path = require('path');

try {
  const { Service } = require('node-windows');

  const svc = new Service({
    name: 'ZebraPrintAgent',
    description: 'Local print agent – forwards Odoo PDFs to Zebra printer',
    script: path.join(__dirname, '..', 'src', 'server.js'),
    env: [
      { name: 'NODE_ENV', value: 'production' },
    ],
    wait: 2,
    grow: 0.25,
  });

  const action = process.argv.includes('--uninstall') ? 'uninstall' : 'install';

  svc.on('install', () => {
    console.log('Service installed. Starting...');
    svc.start();
  });

  svc.on('uninstall', () => {
    console.log('Service uninstalled.');
  });

  svc.on('start', () => console.log('Service started.'));
  svc.on('error', (err) => console.error('Service error:', err));

  svc[action]();
} catch (e) {
  console.error('node-windows not found.');
  console.error('To install as a Windows service, run:');
  console.error('  npm install -g node-windows && npm link node-windows');
  console.error('  node scripts/install-service.js');
  console.error('');
  console.error('Alternatively, use NSSM: https://nssm.cc/');
  console.error('  nssm install ZebraPrintAgent "C:\\Program Files\\nodejs\\node.exe" "C:\\path\\to\\src\\server.js"');
}
