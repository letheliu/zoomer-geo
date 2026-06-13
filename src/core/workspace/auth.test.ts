import { describe, it, expect, vi } from 'vitest'
import { resolveWorkspaceFromHeader } from './auth.js'

describe('auth', () => {
  it('无 header 返回 null', async () => {
    const svc = { findByApiKey: vi.fn() } as any
    const result = await resolveWorkspaceFromHeader(undefined, svc)
    expect(result).toBeNull()
  })

  it('有效 key 返回 workspace', async () => {
    const ws = { id: 'ws-1', name: 'test' }
    const svc = { findByApiKey: vi.fn().mockResolvedValue(ws) } as any
    const result = await resolveWorkspaceFromHeader('geo_secret', svc)
    expect(result).toEqual(ws)
    expect(svc.findByApiKey).toHaveBeenCalledWith('geo_secret')
  })

  it('无效 key 返回 null', async () => {
    const svc = { findByApiKey: vi.fn().mockResolvedValue(null) } as any
    const result = await resolveWorkspaceFromHeader('geo_bad', svc)
    expect(result).toBeNull()
  })
})
