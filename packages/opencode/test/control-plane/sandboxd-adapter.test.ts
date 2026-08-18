import { describe, expect, test } from "bun:test"
import { SandboxdAdapter, sandboxdBaseUrl } from "../../src/control-plane/adapters/sandboxd"

describe("sandboxd workspace adapter", () => {
  test("requires SANDBOXD_ADDR", () => {
    const prev = process.env.SANDBOXD_ADDR
    delete process.env.SANDBOXD_ADDR
    expect(() => sandboxdBaseUrl()).toThrow("SANDBOXD_ADDR")
    if (prev === undefined) delete process.env.SANDBOXD_ADDR
    else process.env.SANDBOXD_ADDR = prev
  })

  test("accepts host:port or URL", () => {
    expect(sandboxdBaseUrl("127.0.0.1:7700")).toBe("http://127.0.0.1:7700")
    expect(sandboxdBaseUrl("http://127.0.0.1:7700/")).toBe("http://127.0.0.1:7700")
  })

  test("configure stamps addr and host directory", () => {
    const prev = process.env.SANDBOXD_ADDR
    process.env.SANDBOXD_ADDR = "127.0.0.1:7700"
    const next = SandboxdAdapter.configure({
      id: "wrk_test123456" as never,
      type: "sandboxd",
      name: "",
      branch: null,
      directory: null,
      extra: null,
      projectID: "prj_test" as never,
    })
    expect(next.directory).toContain("/tmp/opencode-sandboxd-")
    expect((next.extra as { addr?: string }).addr).toBe("127.0.0.1:7700")
    if (prev === undefined) delete process.env.SANDBOXD_ADDR
    else process.env.SANDBOXD_ADDR = prev
  })
})
