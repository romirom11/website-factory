/**
 * Single-process entrypoint: workers + JSON API + demo server.
 * `pnpm all` locally, or CMD in the Docker image.
 *
 * No Telegram bot process: Telegram is notification-only (decision #9) and
 * `notifyTelegram()` posts over plain HTTP. Control lives in the Next.js UI
 * (`ui/`, its own container). `pnpm telegram:setup` runs the one-time
 * chat-id discovery helper.
 */
import { startWorkers, workerRuntimeStats } from './workers/main.js';
import { startApi } from './api/server.js';
import { initSettings, retireHeartbeat, startHeartbeat } from './lib/settingsStore.js';
import { config } from './config.js';
import { log } from './lib/logger.js';

// Load the UI-edited settings BEFORE anything reads config, so a first job that
// fires immediately already sees the operator's values rather than bare env.
await initSettings();
// Before split worker groups, one all-in-one process wrote `heartbeat:workers`.
// It can never become fresh in the current topology and would otherwise render
// as a permanent false outage next to the live `core` and `build` processes.
await retireHeartbeat('workers');

await startWorkers();
await startApi();

// Liveness for the UI's "Стан системи" panel: a row every 30s. Without it the
// console cannot tell "the factory is down" from "there is simply no work".
startHeartbeat('core', () => ({ ...workerRuntimeStats(), mode: config.mode }));

log.info('factory up', { mode: config.mode });
