import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Snapshot } from '../shared/types';

export class Backend {
  private child: ChildProcessWithoutNullStreams;
  private counter = 0;
  private pending = new Map<number, {resolve: (v: Snapshot) => void; reject: (e: Error) => void; timer: NodeJS.Timeout}>();
  constructor(root: string, agentDeck: string | undefined, python: string, packagedExecutable?: string) {
    const args = packagedExecutable ? ['bridge'] : ['-u', join(root, 'python/adapter.py'), 'bridge'];
    if(agentDeck)args.push('--agent-deck',agentDeck);
    if (process.env.PULSAR_EVENT_STORE) args.push('--store', process.env.PULSAR_EVENT_STORE);
    this.child = spawn(packagedExecutable || python, args, {windowsHide: true, env: {...process.env, PYTHONIOENCODING: 'utf-8'}});
    this.child.stderr.on('data', b => console.error('[Agent Deck]', b.toString().trim()));
    createInterface({input: this.child.stdout}).on('line', line => {
      try {
        const msg = JSON.parse(line), waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id); clearTimeout(waiter.timer);
        if (msg.error) waiter.reject(new Error(msg.error)); else waiter.resolve(msg.result);
      } catch (e) { console.error('Invalid adapter response', e); }
    });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', code => this.fail(new Error(`Session backend exited (${code}). Check the installation or run npm run setup in a source checkout.`)));
  }
  private fail(error: Error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  request(method: string, params = {}): Promise<Snapshot> {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      if (this.child.exitCode !== null || this.child.killed) return reject(new Error('Agent Deck adapter is stopped. Restart the app.'));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Agent action timed out. Check Codex; the action was not retried.')); }, 45000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({id, method, params}) + '\n', error => { if (error) this.fail(error); });
    });
  }
  close() { this.child.stdin.end(); setTimeout(() => this.child.kill(), 2000).unref(); }
}
