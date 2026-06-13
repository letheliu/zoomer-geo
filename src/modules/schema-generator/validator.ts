import type { ValidationResult, ValidationError } from './types.js'
import type { SchemaRegistryService } from './schema-registry.js'

export interface SchemaValidatorService {
  validate(doc: unknown): ValidationResult
}

export function createSchemaValidator(registry: SchemaRegistryService): SchemaValidatorService {
  return {
    validate(doc) {
      const errors: ValidationError[] = []

      if (!doc || typeof doc !== 'object') {
        errors.push({ path: '@context', message: 'Document must be an object', code: 'INVALID_CONTEXT' })
        return { valid: false, errors }
      }

      const obj = doc as Record<string, unknown>

      if (obj['@context'] !== 'https://schema.org') {
        errors.push({ path: '@context', message: '@context must be "https://schema.org"', code: 'INVALID_CONTEXT' })
      }

      const type = obj['@type']
      if (typeof type !== 'string' || !registry.isSupported(type)) {
        errors.push({ path: '@type', message: `Unsupported schema type: ${String(type)}`, code: 'INVALID_TYPE' })
        return { valid: false, errors }
      }

      const def = registry.get(type)!
      for (const field of def.requiredFields) {
        const v = obj[field]
        if (v === undefined || v === null || v === '') {
          errors.push({
            path: field,
            message: `Missing required field "${field}" for type "${type}"`,
            code: 'MISSING_REQUIRED',
          })
        }
      }

      return { valid: errors.length === 0, errors }
    },
  }
}