import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Minimal, safe wrapper over the git CLI:
 *  - argument arrays only (never a shell), so repo names cannot inject commands;
 *  - only https (and, when explicitly allowed for tests, file) transports;
 *  - no credential prompts, no system/global config, hard timeout, bounded stderr.
 */
export interface GitOptions {
  cwd?: string;
  timeoutMs: number;
  /** Tests use local file:// remotes; production only ever allows https. */
  allowFileProtocol?: boolean;
  signal?: AbortSignal;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const STDERR_CAP = 8 * 1024;
const STDOUT_CAP = 1024 * 1024; // for runGit (small outputs only); streaming has no cap

const live = new Set<ChildProcess>();

/** Kills any git processes still running (used on shutdown). */
export function killAllGit(): void {
  for (const child of live) child.kill('SIGTERM');
}

function baseArgs(opts: GitOptions): string[] {
  const args = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper='];
  if (opts.allowFileProtocol) args.push('-c', 'protocol.file.allow=always');
  return args;
}

// Only these variables reach git: proxy/CA settings an operator may need, nothing else
// (in particular no tokens from the service's own environment).
const PASS_THROUGH = ['PATH', 'HOME', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE'];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASS_THROUGH) if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    LC_ALL: 'C',
  };
}

function start(args: string[], opts: GitOptions): { child: ChildProcess; done: Promise<void>; stderr: () => string } {
  const child = spawn('git', [...baseArgs(opts), ...args], {
    cwd: opts.cwd,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: opts.signal,
  });
  live.add(child);
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    if (stderr.length < STDERR_CAP) stderr += chunk.slice(0, STDERR_CAP - stderr.length);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      live.delete(child);
      reject(new GitError(`git ${args[0]} failed to start: ${err.message}`, null, stderr));
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      live.delete(child);
      if (code === 0) resolve();
      else {
        const reason = sig === 'SIGKILL' ? `timed out after ${opts.timeoutMs} ms` : `exited with ${code ?? sig}`;
        reject(new GitError(`git ${args[0]} ${reason}: ${summarise(stderr)}`, code, stderr));
      }
    });
  });
  return { child, done, stderr: () => stderr };
}

/** Runs git and returns stdout (capped at 1 MiB; use streamGitLines for large output). */
export async function runGit(args: string[], opts: GitOptions): Promise<string> {
  const { child, done } = start(args, opts);
  let out = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    if (out.length < STDOUT_CAP) out += chunk;
  });
  await done;
  return out;
}

/**
 * Streams git stdout line by line. `onLine` is called synchronously per line; the stream is
 * consumed with backpressure via readline, so memory stays flat for any history size.
 */
export async function streamGitLines(args: string[], opts: GitOptions, onLine: (line: string) => void): Promise<void> {
  const { child, done } = start(args, opts);
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const reading = (async () => {
    try {
      for await (const line of rl) onLine(line);
    } catch (err) {
      child.kill('SIGTERM'); // a consumer failure must not leave git running
      throw err;
    }
  })();
  await Promise.all([done, reading]);
}

/** Strips anything URL-like with credentials and keeps the message short. */
function summarise(stderr: string): string {
  return stderr
    .replace(/https?:\/\/[^\s@/]+@/g, 'https://***@')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .slice(-3)
    .join(' | ')
    .slice(0, 500);
}
