import { describe, it, expect } from 'vitest'
import { createJsonLdBuilder } from './jsonld-builder.js'
import { createSchemaRegistry } from './schema-registry.js'

describe('JsonLdBuilder', () => {
  const builder = createJsonLdBuilder()
  const registry = createSchemaRegistry()

  it('build 注入 @context 和 @type', () => {
    const doc = builder.build({
      type: 'SoftwareApplication',
      fields: { name: 'zoomer AI', applicationCategory: 'DesignApplication' },
    })
    expect(doc['@context']).toBe('https://schema.org')
    expect(doc['@type']).toBe('SoftwareApplication')
  })

  it('build 保留所有白名单内字段', () => {
    const doc = builder.build({
      type: 'SoftwareApplication',
      fields: {
        name: 'zoomer AI',
        applicationCategory: 'DesignApplication',
        description: 'AI 设计工具',
        operatingSystem: 'Web',
      },
    })
    expect(doc['name']).toBe('zoomer AI')
    expect(doc['applicationCategory']).toBe('DesignApplication')
    expect(doc['description']).toBe('AI 设计工具')
    expect(doc['operatingSystem']).toBe('Web')
  })

  it('build 过滤掉白名单外的字段', () => {
    const doc = builder.build({
      type: 'SoftwareApplication',
      fields: {
        name: 'zoomer AI',
        applicationCategory: 'DesignApplication',
        unknownField: 'should be dropped',
      },
    })
    expect((doc as any).unknownField).toBeUndefined()
  })

  it('build 必填字段缺失时抛错', () => {
    expect(() =>
      builder.build({
        type: 'SoftwareApplication',
        fields: { name: 'zoomer AI' },
      }),
    ).toThrow(/applicationCategory/)
  })

  it('build 对未知 type 抛错', () => {
    expect(() =>
      builder.build({
        type: 'UnknownType' as any,
        fields: { name: 'x' },
      }),
    ).toThrow(/UnknownType/)
  })

  it('registry.get 与 builder 行为一致', () => {
    expect(registry.get('SoftwareApplication')).not.toBeNull()
    expect(registry.get('Unknown')).toBeNull()
  })
})