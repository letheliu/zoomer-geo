import type { SupportedSchemaType, SchemaTypeDefinition } from './types.js'

export const SUPPORTED_TYPES: SupportedSchemaType[] = [
  'SoftwareApplication',
  'Organization',
  'Product',
  'FAQPage',
  'Article',
  'BreadcrumbList',
]

const SCHEMA_TYPES: Record<SupportedSchemaType, SchemaTypeDefinition> = {
  SoftwareApplication: {
    type: 'SoftwareApplication',
    requiredFields: ['name', 'applicationCategory'],
    optionalFields: ['description', 'url', 'offers', 'aggregateRating', 'operatingSystem'],
  },
  Organization: {
    type: 'Organization',
    requiredFields: ['name', 'url'],
    optionalFields: ['logo', 'description', 'sameAs'],
  },
  Product: {
    type: 'Product',
    requiredFields: ['name'],
    optionalFields: ['description', 'brand', 'offers', 'image'],
  },
  FAQPage: {
    type: 'FAQPage',
    requiredFields: ['mainEntity'],
    optionalFields: [],
  },
  Article: {
    type: 'Article',
    requiredFields: ['headline', 'author'],
    optionalFields: ['datePublished', 'image', 'articleBody'],
  },
  BreadcrumbList: {
    type: 'BreadcrumbList',
    requiredFields: ['itemListElement'],
    optionalFields: [],
  },
}

export interface SchemaRegistryService {
  get(type: string): SchemaTypeDefinition | null
  isSupported(type: string): boolean
  list(): SupportedSchemaType[]
}

export function createSchemaRegistry(): SchemaRegistryService {
  return {
    get(type) {
      return (SCHEMA_TYPES as Record<string, SchemaTypeDefinition | undefined>)[type] ?? null
    },
    isSupported(type) {
      return type in SCHEMA_TYPES
    },
    list() {
      return [...SUPPORTED_TYPES]
    },
  }
}
