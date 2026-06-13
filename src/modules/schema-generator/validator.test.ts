import { describe, it, expect } from 'vitest'
import { createSchemaValidator } from './validator.js'
import { createSchemaRegistry } from './schema-registry.js'

describe('SchemaValidator', () => {
  const validator = createSchemaValidator(createSchemaRegistry())

  it('合法 JSON-LD 返回 valid: true', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'zoomer AI',
      applicationCategory: 'DesignApplication',
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('@context 错误返回 INVALID_CONTEXT', () => {
    const result = validator.validate({
      '@context': 'https://example.com',
      '@type': 'SoftwareApplication',
      name: 'x',
      applicationCategory: 'y',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_CONTEXT')).toBe(true)
  })

  it('@type 不在白名单返回 INVALID_TYPE', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'UnknownType',
      name: 'x',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('必填字段缺失返回 MISSING_REQUIRED', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'x',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MISSING_REQUIRED' && e.path === 'applicationCategory')).toBe(true)
  })

  it('多重错误同时报告', () => {
    const result = validator.validate({
      '@context': 'https://example.com',
      '@type': 'UnknownType',
    })
    expect(result.valid).toBe(false)
    const codes = result.errors.map((e) => e.code)
    expect(codes).toContain('INVALID_CONTEXT')
    expect(codes).toContain('INVALID_TYPE')
  })

  it('非对象输入返回 INVALID_CONTEXT', () => {
    const result = validator.validate(null)
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('INVALID_CONTEXT')
  })
})