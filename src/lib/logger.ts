import { redactSensitiveValue } from './redaction.js';

type Ctx = Record<string, unknown>;

function line(level: string, msg: string, ctx?: Ctx) {
  const entry = redactSensitiveValue({ t: new Date().toISOString(), level, msg, ...ctx });
  console.log(JSON.stringify(entry));
}

export const log = {
  info: (msg: string, ctx?: Ctx) => line('info', msg, ctx),
  warn: (msg: string, ctx?: Ctx) => line('warn', msg, ctx),
  error: (msg: string, ctx?: Ctx) => line('error', msg, ctx),
};
