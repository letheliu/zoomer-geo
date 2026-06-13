import { describe, it, expect } from 'vitest'
import { createSchemaRegistry, SUPPORTED_TYPES } from './schema-registry.js'

describe('SchemaRegistry', () => {
  const registry = createSchemaRegistry()

  it('list 返回全部 6 种支持的类型', () => {
    const types = registry.list()
    expect(types).toHaveLength(6)
    expect(types).toEqual(expect.arrayContaining(SUPPORTED_TYPES))
  })

  it('isSupported 对白名单类型返回 true', () => {
    expect(registry.isSupported('SoftwareApplication')).toBe(true)
    expect(registry.isSupported('Organization')).toBe(true)
    expect(registry.isSupported('FAQPage')).toBe(true)
  })

  it('isSupported 对未知类型返回 false', () => {
    expect(registry.isSupported('UnknownType')).toBe(false)
    expect(registry.isSupported('')).toBe(false)
  })

  it('get 返回已知类型的字段定义', () => {
    const def = registry.get('SoftwareApplication')
    expect(def).not.toBeNull()
    expect(def!.requiredFields).toEqual(['name', 'applicationCategory'])
    expect(def!.optionalFields).toContain('description')
  })

  it('get 对未知类型返回 null', () => {
    expect(registry.get('Unknown')).toBeNull()
  })
})
