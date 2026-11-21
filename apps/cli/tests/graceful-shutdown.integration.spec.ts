import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Real-composition shutdown: boot the shipped Web profile from source, deliver
 * the same interrupt twice as a terminal does, and assert the process exits with
 * the interrupt code and leaves no owned child behind.
 */

const roots: string[] = []
const children: Promise<unknown>[] = []

afterEach(async () => {
  await Promise.allSettled(children.splice(0))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-graceful-shutdown-'))
  roots.push(root)
  return root
}

interface Booted {
  readonly child: ReturnType<typeof spawn>
  readonly url: string
  exited: Promise<number | null>
}

/** Start the Web profile and resolve once it prints its listening URL. */
async function bootWeb(): Promise<Booted> {
  const home = await tempHome()
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', '0', '--no-open'], {
    cwd: process.cwd(),
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => { resolve(code) })
  })
  children.push(exited)
  const url = await new Promise<string>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { reject(new Error(`web profile did not start; output:\n${output}`)) }, 180_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`web profile exited (${String(code)}) before listening; output:\n${output}`))
    })
  })
  return { child, url, exited }
}

/** Direct child process ids of the spawned application. */
function childPids(pid: number): number[] {
  try {
    const rows = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
    return rows.trim().split('\n')
      .map(row => row.trim().split(/\s+/).map(Number))
      .filter(([, ppid]) => ppid === pid)
      .map(([child]) => child!)
  } catch {
    return []
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('graceful process shutdown', () => {
  it('survives the duplicate interrupt a terminal delivers and exits with its code', async () => {
    const application = await bootWeb()
    const before = childPids(application.child.pid!)

    application.child.kill('SIGINT')
    application.child.kill('SIGINT')

    const code = await application.exited
    expect(code).toBe(130)
    const survivors = before.filter(alive)
    expect(survivors).toEqual([])
  }, 240_000)

  it('exits successfully on a termination request', async () => {
    const application = await bootWeb()

    application.child.kill('SIGTERM')

    expect(await application.exited).toBe(0)
  }, 240_000)
})
