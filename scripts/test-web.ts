#!/usr/bin/env bun
// @ref LLP 0019#cli-flow — Expo Web smoke runner driven by agent-browser.

import { spawn } from 'bun';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';

const STARTUP_TIMEOUT_MS = 60_000;
const APP_READY_TEXT = 'Web Standard Camera';

interface Options {
  port?: number;
  keepOpen: boolean;
  strictConsole: boolean;
}

interface BrowserConsoleMessage {
  type: string;
  text: string;
}

interface BrowserPageError {
  text: string;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('test:web failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const port = options.port ?? await pickFreePort();
  const url = `http://localhost:${port}/`;
  const session = `standard-camera-web-${process.pid}`;
  const expoLog: string[] = [];

  console.log(`Starting Expo Web on ${url}`);
  const expo = spawn({
    cmd: ['bun', 'run', 'web', '--', '--localhost', '--port', String(port)],
    env: { ...process.env, CI: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  pumpLog(expo.stdout as ReadableStream<Uint8Array>, 'expo', expoLog);
  pumpLog(expo.stderr as ReadableStream<Uint8Array>, 'expo', expoLog);

  let exitCode = 1;
  try {
    await waitForExpo(url);
    await agentBrowser(session, ['console', '--json', '--clear']);
    await agentBrowser(session, ['errors', '--json', '--clear']);

    console.log(`Opening ${url} with agent-browser`);
    await agentBrowser(session, ['--json', 'open', url]);
    await agentBrowser(session, ['wait', '3000']);

    const page = await evalJson<{
      title: string;
      url: string;
      text: string;
      hasExpoErrorOverlay: boolean;
    }>(session, `(() => ({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText : '',
      hasExpoErrorOverlay: Boolean(document.querySelector('[data-expo-error-overlay]')) ||
        (document.body?.innerText ?? '').includes('Cannot find native module')
    }))()`);

    const consoleMessages = await getConsole(session);
    const pageErrors = await getPageErrors(session);

    printBrowserLogs(consoleMessages, pageErrors);

    const failures: string[] = [];
    if (page.title !== 'standard-camera-app') {
      failures.push(`expected title "standard-camera-app", got "${page.title}"`);
    }
    if (!page.text.includes(APP_READY_TEXT)) {
      failures.push(`expected page text to include "${APP_READY_TEXT}"`);
    }
    if (page.hasExpoErrorOverlay) {
      failures.push('Expo error overlay is visible');
    }
    if (pageErrors.length > 0) {
      failures.push(`${pageErrors.length} browser page error(s)`);
    }
    const consoleProblems = consoleMessages.filter((message) =>
      options.strictConsole
        ? message.type === 'error' || message.type === 'warning'
        : message.type === 'error'
    );
    if (consoleProblems.length > 0) {
      failures.push(`${consoleProblems.length} browser console ${options.strictConsole ? 'error/warning' : 'error'} log(s)`);
    }

    if (failures.length > 0) {
      console.error('');
      console.error('Expo Web smoke failed:');
      for (const failure of failures) console.error(`- ${failure}`);
      await printExpoLogTail(expoLog);
      exitCode = 1;
    } else {
      console.log('');
      console.log('Expo Web smoke passed.');
      exitCode = 0;
    }
  } finally {
    if (!options.keepOpen) {
      await agentBrowser(session, ['close']).catch(() => undefined);
      expo.kill();
      await expo.exited.catch(() => undefined);
    } else {
      console.log(`Leaving Expo Web running at ${url}`);
    }
  }

  return exitCode;
}

function parseArgs(args: string[]): Options {
  const options: Options = { keepOpen: false, strictConsole: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--keep-open') {
      options.keepOpen = true;
    } else if (arg === '--strict-console') {
      options.strictConsole = true;
    } else if (arg === '--port') {
      const raw = args[++i];
      const port = Number(raw);
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Invalid --port value: ${raw}`);
      }
      options.port = port;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local TCP port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForExpo(url: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const statusUrl = new URL('/status', url).toString();
  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl);
      const text = await response.text();
      if (text.includes('packager-status:running')) return;
    } catch {
      // keep polling
    }
    await sleep(500);
  }
  throw new Error(`Timed out after ${STARTUP_TIMEOUT_MS}ms waiting for Expo Web`);
}

function pumpLog(
  stream: ReadableStream<Uint8Array>,
  label: string,
  sink: string[]
): void {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = stripAnsi(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        sink.push(line);
        if (sink.length > 300) sink.shift();
        console.log(`[${label}] ${line}`);
      }
    }
  })();
}

async function agentBrowser(session: string, args: string[]): Promise<string> {
  const proc = spawn({
    cmd: ['agent-browser', '--session', session, ...args],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `agent-browser ${args.join(' ')} failed (${code})\n${stdout}${stderr}`
    );
  }
  return stdout;
}

async function evalJson<T>(session: string, expression: string): Promise<T> {
  const out = await agentBrowser(session, ['eval', '--json', expression]);
  const parsed = JSON.parse(out) as { success: boolean; data?: { result: T }; error?: string };
  if (!parsed.success || !parsed.data) {
    throw new Error(parsed.error ?? 'agent-browser eval failed');
  }
  return parsed.data.result;
}

async function getConsole(session: string): Promise<BrowserConsoleMessage[]> {
  const out = await agentBrowser(session, ['console', '--json']);
  const parsed = JSON.parse(out) as {
    success: boolean;
    data?: { messages?: BrowserConsoleMessage[] };
    error?: string;
  };
  if (!parsed.success) throw new Error(parsed.error ?? 'agent-browser console failed');
  return parsed.data?.messages ?? [];
}

async function getPageErrors(session: string): Promise<BrowserPageError[]> {
  const out = await agentBrowser(session, ['errors', '--json']);
  const parsed = JSON.parse(out) as {
    success: boolean;
    data?: { errors?: BrowserPageError[] };
    error?: string;
  };
  if (!parsed.success) throw new Error(parsed.error ?? 'agent-browser errors failed');
  return parsed.data?.errors ?? [];
}

function printBrowserLogs(
  consoleMessages: BrowserConsoleMessage[],
  pageErrors: BrowserPageError[]
): void {
  console.log('');
  console.log(`Browser console logs: ${consoleMessages.length}`);
  for (const message of consoleMessages) {
    console.log(`[browser:${message.type}] ${message.text}`);
  }
  console.log(`Browser page errors: ${pageErrors.length}`);
  for (const error of pageErrors) {
    console.log(`[browser:error] ${error.text}`);
  }
}

async function printExpoLogTail(memoryTail: string[]): Promise<void> {
  console.error('');
  console.error('Dev server log tail:');
  const fileTail = await readFile('.expo/dev/logs/start.log', 'utf8')
    .then((text) => text.split('\n').filter(Boolean).slice(-40))
    .catch(() => []);
  const lines = fileTail.length > 0 ? fileTail : memoryTail.slice(-40);
  for (const line of lines) {
    console.error(stripAnsi(line));
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
