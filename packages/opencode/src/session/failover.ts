import { Log } from "@/util/log"
import { Config } from "@/config/config"

export namespace ModelFailover {
  const log = Log.create({ service: "model.failover" })

  export type Endpoint = {
    providerID: string
    /** Model id — matches `Provider.Model.id` (not `modelID`). */
    modelID: string
  }

  /** Accept either a `Provider.Model` (`.id`) or an Endpoint (`.modelID`). */
  export function asEndpoint(model: { providerID: string; id?: string; modelID?: string }): Endpoint {
    return { providerID: model.providerID, modelID: model.modelID ?? model.id! }
  }

  export type Pool = {
    /** provider/model refs in failover order. Index 0 is the preferred start. */
    endpoints: Endpoint[]
    /** Base cooldown after a failure, doubled per consecutive failure. */
    cooldownMs: number
  }

  const MAX_COOLDOWN_MS = 10 * 60 * 1000
  const DEFAULT_COOLDOWN_MS = 60_000

  /**
   * Consecutive failures on the active endpoint before a request hops to
   * the next pool entry. A single transient blip retries in-place (cheap,
   * prompt-cache-warm); repeated failures mean the endpoint is degraded.
   */
  export const FAILOVER_THRESHOLD = 2

  type EndpointHealth = {
    consecutiveFailures: number
    cooldownUntil: number
  }

  const health = new Map<string, EndpointHealth>()
  /** Round-robin cursor so concurrent sessions spread across the pool. */
  let rotation = 0

  function key(endpoint: Endpoint) {
    return `${endpoint.providerID}/${endpoint.modelID}`
  }

  function endpointHealth(endpoint: Endpoint): EndpointHealth {
    const k = key(endpoint)
    let h = health.get(k)
    if (!h) {
      h = { consecutiveFailures: 0, cooldownUntil: 0 }
      health.set(k, h)
    }
    return h
  }

  export function parseEndpoint(ref: string): Endpoint | undefined {
    const [providerID, ...rest] = ref.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return undefined
    return { providerID, modelID }
  }

  /** Load [model_failover] from config. `undefined` when disabled/unset. */
  export async function getPool(): Promise<Pool | undefined> {
    const cfg = await Config.get()
    const fanout = cfg.model_failover
    if (!fanout?.enabled || !fanout.default_model) return undefined
    const refs = fanout.pool?.length ? fanout.pool : [fanout.default_model]
    const endpoints = refs.map(parseEndpoint).filter((e): e is Endpoint => !!e)
    if (endpoints.length === 0) return undefined
    return {
      endpoints,
      cooldownMs: fanout.cooldown_ms ?? DEFAULT_COOLDOWN_MS,
    }
  }

  /**
   * The pool applies ONLY to the fanout default model — explicit model
   * choices are never hijacked. Compares normalized provider/model refs.
   */
  export async function applies(model: { providerID: string; id?: string; modelID?: string }): Promise<Pool | undefined> {
    const pool = await getPool()
    if (!pool) return undefined
    const cfg = await Config.get()
    const defaultRef = cfg.model_failover!.default_model!
    const parsed = parseEndpoint(defaultRef)
    if (!parsed) return undefined
    const modelId = model.modelID ?? model.id!
    if (parsed.providerID !== model.providerID || parsed.modelID !== modelId) return undefined
    return pool
  }

  /** Mark an endpoint failed: cooldown doubles per consecutive failure. */
  export function markFailed(pool: Pool, endpoint: Endpoint) {
    const h = endpointHealth(endpoint)
    h.consecutiveFailures++
    const ms = Math.min(pool.cooldownMs * 2 ** (h.consecutiveFailures - 1), MAX_COOLDOWN_MS)
    h.cooldownUntil = Date.now() + ms
    log.info("endpoint failed", {
      endpoint: key(endpoint),
      consecutiveFailures: h.consecutiveFailures,
      cooldownMs: ms,
    })
  }

  /** Mark an endpoint healthy: clears failure streak and cooldown. */
  export function markHealthy(endpoint: Endpoint) {
    const h = endpointHealth(endpoint)
    if (h.consecutiveFailures > 0 || h.cooldownUntil > 0) {
      log.info("endpoint recovered", { endpoint: key(endpoint) })
    }
    h.consecutiveFailures = 0
    h.cooldownUntil = 0
  }

  /** Current consecutive-failure count (failover threshold bookkeeping). */
  export function failures(endpoint: Endpoint): number {
    return endpointHealth(endpoint).consecutiveFailures
  }

  function cooling(endpoint: Endpoint): boolean {
    return endpointHealth(endpoint).cooldownUntil > Date.now()
  }

  /**
   * Next healthy endpoint, rotating the start index per call so concurrent
   * sessions spread across the pool. Returns `undefined` when every entry
   * is cooling down (caller falls back to normal retry behavior).
   */
  export function nextHealthy(pool: Pool, exclude?: Endpoint): Endpoint | undefined {
    const n = pool.endpoints.length
    if (n === 0) return undefined
    const start = rotation++ % n
    for (let i = 0; i < n; i++) {
      const candidate = pool.endpoints[(start + i) % n]
      if (exclude && key(candidate) === key(exclude)) continue
      if (cooling(candidate)) continue
      return candidate
    }
    return undefined
  }
}
