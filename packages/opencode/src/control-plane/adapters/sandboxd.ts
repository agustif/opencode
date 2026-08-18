import type { WorkspaceAdapter } from "../types"

export type SandboxdExtra = {
  addr?: string
  sandbox_id?: string
  checkpoint_id?: string
  memory_bytes?: number
  vcpus?: number
}

const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024
const DEFAULT_VCPUS = 1

export function sandboxdBaseUrl(addr = process.env.SANDBOXD_ADDR): string {
  if (!addr || addr.trim() === "") {
    throw new Error("SANDBOXD_ADDR is required for sandboxd workspaces")
  }
  const trimmed = addr.trim()
  return trimmed.includes("://") ? trimmed.replace(/\/$/, "") : `http://${trimmed}`
}

function extraOf(info: { extra?: unknown }): SandboxdExtra {
  if (!info.extra || typeof info.extra !== "object") return {}
  return info.extra as SandboxdExtra
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`sandboxd ${init.method ?? "GET"} ${url} failed: ${response.status} ${text}`)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

function decodeBytes(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return Buffer.from(value as number[]).toString("utf8")
  return ""
}

export async function sandboxdExec(input: {
  addr?: string
  sandboxId: string
  command: string
  timeoutMs?: number
}): Promise<{ exit: number; stdout: string; stderr: string }> {
  const base = sandboxdBaseUrl(input.addr)
  const body = await request<{
    exit_code: number
    stdout: unknown
    stderr: unknown
  }>(`${base}/v1/sandboxes/${input.sandboxId}/exec`, {
    method: "POST",
    body: JSON.stringify({
      program: "/bin/sh",
      args: ["-c", input.command],
      max_output_bytes: 1024 * 1024,
    }),
    signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined,
  })
  return {
    exit: body.exit_code,
    stdout: decodeBytes(body.stdout),
    stderr: decodeBytes(body.stderr),
  }
}

export const SandboxdAdapter: WorkspaceAdapter = {
  name: "sandboxd",
  description: "Restore a Firecracker sandbox via sandboxd (one VM per workspace)",
  configure(info) {
    const extra = extraOf(info)
    const addr = extra.addr ?? process.env.SANDBOXD_ADDR
    const checkpoint = extra.checkpoint_id ?? process.env.SANDBOXD_CHECKPOINT
    const memory = extra.memory_bytes ?? Number(process.env.SANDBOXD_MEMORY_BYTES ?? DEFAULT_MEMORY_BYTES)
    const vcpus = extra.vcpus ?? Number(process.env.SANDBOXD_VCPUS ?? DEFAULT_VCPUS)
    return {
      ...info,
      name: info.name || `sandboxd-${info.id.slice(0, 8)}`,
      directory: info.directory || `/tmp/opencode-sandboxd-${info.id}`,
      extra: {
        ...extra,
        addr,
        checkpoint_id: checkpoint,
        memory_bytes: Number.isFinite(memory) && memory > 0 ? memory : DEFAULT_MEMORY_BYTES,
        vcpus: Number.isFinite(vcpus) && vcpus > 0 ? vcpus : DEFAULT_VCPUS,
      } satisfies SandboxdExtra,
    }
  },
  async create(info) {
    const extra = extraOf(info)
    const base = sandboxdBaseUrl(extra.addr)
    const created = extra.checkpoint_id
      ? await request<{ id: string }>(`${base}/v1/checkpoints/${extra.checkpoint_id}/fork`, {
          method: "POST",
        })
      : await request<{ id: string }>(`${base}/v1/sandboxes`, {
          method: "POST",
          body: JSON.stringify({
            memory_bytes: extra.memory_bytes ?? DEFAULT_MEMORY_BYTES,
            vcpus: extra.vcpus ?? DEFAULT_VCPUS,
            name: info.name,
          }),
        })
    extra.sandbox_id = created.id
    info.extra = extra
    if (info.directory) {
      await import("node:fs/promises").then((fs) => fs.mkdir(info.directory!, { recursive: true }))
    }
  },
  async remove(info) {
    const extra = extraOf(info)
    if (!extra.sandbox_id) return
    const base = sandboxdBaseUrl(extra.addr)
    await request(`${base}/v1/sandboxes/${extra.sandbox_id}`, { method: "DELETE" }).catch((error) => {
      if (String(error).includes(" 404 ")) return
      throw error
    })
  },
  target(info) {
    // File tools stay on the host worktree/dir. Shell is routed to the VM
    // via extra.sandbox_id (see tool/shell.ts).
    if (!info.directory) {
      throw new Error("sandboxd workspace is missing a host directory")
    }
    return { type: "local", directory: info.directory }
  },
}
